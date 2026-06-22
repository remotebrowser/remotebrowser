import asyncio
import time
from typing import Any

from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    CreateSandboxFromSnapshotParams,
    DaytonaConfig,
    DaytonaConflictError,
    DaytonaNotFoundError,
    ListSandboxesQuery,
)
from loguru import logger

from getgather.browsers.backend import (
    BROWSER_NAME_PREFIX,
    INCOGNITO_PREFIX,
    BrowserNotFound,
    mint_incognito_browser_id,
)
from getgather.browsers.residential_proxy import get_proxy_config
from getgather.config import settings


class ProxyVerificationError(Exception):
    """Raised when egress IP is unchanged after proxy configuration."""


CDP_PORT = 9222
VNC_PORT = 8080

# Chrome stores last_visit_time as microseconds since 1601-01-01; this offset converts to unix epoch.
CHROMIUM_EPOCH_OFFSET_SECONDS = 11644473600
CHROME_HISTORY_PATH = "/home/user/chrome-profile/Default/History"

# Daytona auto-stops a sandbox after this many idle minutes (no sandbox event), parking it at
# $0 compute. Once it has been continuously stopped for TTL_MINUTES, Daytona's native
# auto_delete_interval (set at create time) deletes it.
AUTO_STOP_MINUTES = 15
TTL_MINUTES = 60

# CDP is reached over a Daytona signed preview URL: a self-authenticating HTTPS reverse proxy to
# the sandbox's port 9222 (https://9222-<token>.<proxy-domain>).
#
# SECURITY: this URL is PUBLICLY reachable on the internet. The sandbox is created public=False,
# but a signed preview URL bypasses that — the only credential is the token embedded in the URL
# itself, so anyone who obtains the cdp_url can drive the browser's CDP until the token expires.
# Treat cdp_url as a bearer secret. The token is stateless and survives sandbox restarts.
SIGNED_URL_TTL_SECONDS = 3600

# An open live-view iframe streams noVNC over port 8080, which Daytona counts as sandbox activity
# and uses to reset auto_stop_interval. The dashboard embeds a live view per browser, so without a
# gate just viewing it would keep every sandbox alive indefinitely (defeating auto-stop). Only hand
# out the live URL when the browser has had real Chrome activity within this window; otherwise let
# the idle sandbox auto-stop. A sandbox with no history yet (e.g. a fresh sign-in) is treated as
# active so the primary "watch the sign-in" flow keeps working.
LIVE_VIEW_MAX_IDLE_SECONDS = 3600

LABEL_FLEET = "fleet"
# A spare carries pool=spare; on claim the label is dropped so it reads as a normal browser and the
# 15m auto-stop / 60m auto-delete teardown applies unchanged.
LABEL_POOL = "pool"
POOL_SPARE = "spare"


def _sandbox_name(browser_id: str) -> str:
    return f"{BROWSER_NAME_PREFIX}{browser_id}"


async def _configure_sandbox_proxy(sandbox: AsyncSandbox, proxy_url: str) -> bool:
    stripped = proxy_url.removeprefix("http://")
    cmds = [
        "sed -i '/^Upstream http/d' /app/tinyproxy.conf",
        f"sed -i '$ a\\Upstream http {stripped}' /app/tinyproxy.conf",
        "sudo /command/s6-svc -r /run/service/tinyproxy",
        "while ! curl -s -o /dev/null -x http://localhost:8119 http://tinyproxy.stats; do sleep 0.1; done",
    ]
    for cmd in cmds:
        try:
            response = await sandbox.process.exec(cmd)
        except Exception as e:
            logger.warning(f"Proxy config failed on {sandbox.name}: {type(e).__name__}: {e}")
            return False
        if response.exit_code != 0:
            logger.warning(
                f"Proxy config exit={response.exit_code} on {sandbox.name}: cmd={cmd!r} stderr={response.result!r}"
            )
            return False
    return True


async def _get_sandbox_public_ip(
    sandbox: AsyncSandbox, *, retries: int = 5, retry_delay: float = 2.0
) -> str | None:
    cmd = "curl -s --max-time 10 --proxy http://127.0.0.1:8119 https://ip.fly.dev"
    for attempt in range(1, retries + 1):
        try:
            response = await sandbox.process.exec(cmd)
            ip = response.result.strip() if response.exit_code == 0 else ""
            if ip:
                return ip
        except Exception as e:
            logger.debug(f"IP check {attempt}/{retries} on {sandbox.name} failed: {e}")
        if attempt < retries:
            await asyncio.sleep(retry_delay)
    logger.warning(f"IP check on {sandbox.name} failed after {retries} attempts")
    return None


async def _configure_remote_sandbox(
    sandbox: AsyncSandbox,
    browser_id: str,
    origin_ip: str | None,
    target_domain: str | None,
) -> None:
    proxy_config = await get_proxy_config(origin_ip, target_domain, settings)
    proxy_url = proxy_config.get_proxy_url(browser_id) if proxy_config else None

    if not proxy_url:
        return

    ip_before = await _get_sandbox_public_ip(sandbox)
    logger.debug(f"Sandbox {sandbox.name} IP before proxy: {ip_before}")

    ok = await _configure_sandbox_proxy(sandbox, proxy_url)
    if not ok:
        return

    ip_after = await _get_sandbox_public_ip(sandbox)
    if ip_before and ip_after and ip_before != ip_after:
        logger.info(f"Sandbox {sandbox.name} IP changed: {ip_before} -> {ip_after}")
    elif ip_before == ip_after:
        raise ProxyVerificationError(
            f"Sandbox {sandbox.name} IP unchanged after proxy: {ip_before}"
        )


def _browser_id_from_name(name: str) -> str:
    return name.removeprefix(BROWSER_NAME_PREFIX)


class DaytonaBackend:
    """Launch a Daytona sandbox per browser on demand (no pool).

    The browser_id -> sandbox mapping is the deterministic sandbox name plus labels, so there is
    no local state. CDP is reached over a Daytona signed preview URL: a public, internet-reachable,
    self-authenticating HTTPS reverse proxy to port 9222 (no inbound networking into the sandbox is
    required). Live view embeds the snapshot's built-in noVNC on port 8080 via a signed preview URL.
    Residential proxy/geo-IP are supported via tinyproxy (preconfigured in the snapshot, same as podman).

    Sandbox teardown is owned by Daytona: auto_stop_interval stops idle sandboxes and
    auto_delete_interval deletes them once continuously stopped past the TTL (both set at create
    time in _create).
    """

    def __init__(self, api_key: str, api_url: str, snapshot: str) -> None:
        self.snapshot = snapshot
        self.client = AsyncDaytona(DaytonaConfig(api_key=api_key, api_url=api_url or None))
        self._locks: dict[str, asyncio.Lock] = {}
        self._pool_size = settings.DAYTONA_INCOGNITO_POOL_SIZE
        # In-memory set of ready spare browser_ids. Single-process pool: the lock makes claim
        # atomic within this process; a multi-instance deployment would need a shared store.
        self._spares: set[str] = set()
        self._pool_lock = asyncio.Lock()
        # Maps a requested incognito browser_id -> the claimed spare's real browser_id. A spare
        # keeps its own (immutable) sandbox name, so every lookup resolves through this map. In
        # memory only: a future multi-instance deployment would move it to a shared store.
        self._id_map: dict[str, str] = {}

    def _effective_id(self, browser_id: str) -> str:
        return self._id_map.get(browser_id, browser_id)

    async def startup(self) -> None:
        if self._pool_size <= 0:
            return
        # Adopt spares that survived a restart, then backfill — both in the background so server
        # startup is never blocked on Daytona.
        asyncio.create_task(self._reconcile_pool())

    async def shutdown(self) -> None:
        await self.client.close()

    async def create_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        # Incognito requests claim a warm-pool spare when one is ready: the spare keeps its own
        # sandbox name and we map the requested id -> the spare's id (resolved on every later
        # lookup). Non-incognito (per-user) ids and an empty pool fall through to cold-create.
        effective_id = await self._claim_spare_for(browser_id)
        lock = self._locks.setdefault(effective_id, asyncio.Lock())
        async with lock:
            sandbox = await self._ensure(effective_id)
            try:
                await _configure_remote_sandbox(sandbox, effective_id, origin_ip, target_domain)
            except ProxyVerificationError as e:
                logger.warning(str(e))
            return await self._get_info(sandbox)

    async def get_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        effective_id = self._effective_id(browser_id)
        sandbox = await self._get(_sandbox_name(effective_id))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if origin_ip:
            try:
                await _configure_remote_sandbox(sandbox, effective_id, origin_ip, target_domain)
            except ProxyVerificationError as e:
                logger.warning(str(e))
        return await self._get_info(sandbox)

    async def delete_browser(self, browser_id: str) -> dict[str, Any]:
        effective_id = self._effective_id(browser_id)
        sandbox = await self._get(_sandbox_name(effective_id))
        self._locks.pop(effective_id, None)
        self._id_map.pop(browser_id, None)
        if sandbox is None:
            return {"status": "not found"}
        await sandbox.delete()
        return {"status": "deleted"}

    async def browser_exists(self, browser_id: str) -> bool:
        return await self._get(_sandbox_name(self._effective_id(browser_id))) is not None

    async def list_browser_ids(self) -> list[str]:
        browser_ids: list[str] = []
        async for sandbox in self.client.list(ListSandboxesQuery(labels={LABEL_FLEET: "1"})):
            # A just-deleted sandbox lingers briefly as `DESTROYED_<name>_<ts>`; only our names count.
            if sandbox.name and sandbox.name.startswith(BROWSER_NAME_PREFIX):
                browser_ids.append(_browser_id_from_name(sandbox.name))
        return browser_ids

    async def cleanup_idle(self) -> list[str]:
        # Teardown is owned by Daytona's native auto_stop_interval + auto_delete_interval (set in
        # _create). The only periodic work is keeping the warm pool topped up (spares that Daytona
        # auto-stopped after idle are dropped and respawned here).
        if self._pool_size > 0:
            await self._reconcile_pool()
        return []

    async def _claim_spare_for(self, browser_id: str) -> str:
        """For an incognito request, claim a ready spare and map browser_id -> the spare's id.

        Returns the spare's id when one was claimed, else the original browser_id (cold-create
        path). Only incognito ids are eligible; per-user ids always cold-create under their own
        deterministic name.
        """
        if self._pool_size <= 0 or not browser_id.startswith(INCOGNITO_PREFIX):
            return browser_id

        spare_id: str | None = None
        async with self._pool_lock:
            while self._spares:
                candidate = self._spares.pop()
                sandbox = await self._get(_sandbox_name(candidate))
                if sandbox is not None and sandbox.state == "started":
                    spare_id = candidate
                    break
                logger.info(f"Discarding stale spare {candidate} (state unavailable)")

        if spare_id is None:
            logger.info(f"Pool empty; cold-creating incognito browser {browser_id}")
            return browser_id

        # Drop the spare label so normal teardown applies; best-effort (claim already succeeded).
        try:
            spare = await self._get(_sandbox_name(spare_id))
            if spare is not None:
                await spare.set_labels({LABEL_FLEET: "1"})
        except Exception as e:
            logger.warning(f"Failed to clear pool label on {spare_id}: {e}")

        self._id_map[browser_id] = spare_id
        logger.info(f"Claimed pooled spare {spare_id} for incognito browser {browser_id}")
        asyncio.create_task(self._reconcile_pool())
        return spare_id

    async def _reconcile_pool(self) -> None:
        """Sync the in-memory spare set with Daytona, then backfill to POOL_SIZE.

        Idempotent and safe to call repeatedly. Serialized under the pool lock so concurrent
        callers (startup, periodic sweep, post-claim backfill) don't over-provision.
        """
        async with self._pool_lock:
            live: set[str] = set()
            async for sandbox in self.client.list(
                ListSandboxesQuery(labels={LABEL_FLEET: "1", LABEL_POOL: POOL_SPARE})
            ):
                if (
                    sandbox.name
                    and sandbox.name.startswith(BROWSER_NAME_PREFIX)
                    and sandbox.state == "started"
                ):
                    live.add(_browser_id_from_name(sandbox.name))
            self._spares = live
            deficit = self._pool_size - len(self._spares)

        for _ in range(max(0, deficit)):
            try:
                browser_id = await self._spawn_spare()
            except Exception as e:
                logger.warning(f"Failed to spawn pool spare: {type(e).__name__}: {e}")
                break
            async with self._pool_lock:
                self._spares.add(browser_id)

    async def _spawn_spare(self) -> str:
        browser_id = mint_incognito_browser_id()
        name = _sandbox_name(browser_id)
        logger.info(f"Spawning pool spare {name}")
        await self._create(name, labels={LABEL_FLEET: "1", LABEL_POOL: POOL_SPARE})
        return browser_id

    async def get_cdp_base_url(self, browser_id: str) -> str:
        sandbox = await self._get(_sandbox_name(self._effective_id(browser_id)))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        signed = await sandbox.create_signed_preview_url(
            CDP_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        return signed.url

    def cdp_websocket_base(self) -> None:
        # CDP is reached per-sandbox over a signed HTTPS preview URL via get_cdp_base_url +
        # /json/version, not a shared websocket proxy, so there is no relay base.
        return None

    async def get_vnc_endpoint(self, browser_id: str) -> tuple[str, int] | None:
        return None  # no raw VNC port; live view uses get_live_view_url (noVNC on VNC_PORT)

    async def get_live_view_url(self, browser_id: str) -> str | None:
        sandbox = await self._get(_sandbox_name(self._effective_id(browser_id)))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if sandbox.state != "started":
            return None  # a stopped sandbox has nothing to show and must not be woken to watch it

        # Gate on recent activity so an embedded live view can't keep an idle sandbox alive. A
        # missing timestamp (no history yet / read error) is treated as active to avoid hiding the
        # live view for a fresh sign-in.
        last_activity = await self._get_last_activity(sandbox)
        if last_activity is not None:
            idle_seconds = time.time() - last_activity
            if idle_seconds > LIVE_VIEW_MAX_IDLE_SECONDS:
                logger.info(
                    f"Skipping live view for idle sandbox {sandbox.name}: "
                    f"last activity {idle_seconds:.0f}s ago (> {LIVE_VIEW_MAX_IDLE_SECONDS}s)"
                )
                return None

        signed = await sandbox.create_signed_preview_url(
            VNC_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        return signed.url

    async def _ensure(self, browser_id: str) -> AsyncSandbox:
        name = _sandbox_name(browser_id)
        sandbox = await self._get(name)
        if sandbox is None:
            sandbox = await self._create(name)

        if sandbox.state != "started":
            logger.info(f"Starting Daytona sandbox {name} (state={sandbox.state})")
            await sandbox.start()

        return sandbox

    async def _get_info(self, sandbox: AsyncSandbox) -> dict[str, Any]:
        signed = await sandbox.create_signed_preview_url(
            CDP_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        return {
            "hostname": sandbox.name,
            "cdp_url": signed.url,  # public, internet-reachable; bearer secret (see SIGNED_URL_TTL_SECONDS)
            "app_state": sandbox.state,
            "last_activity_timestamp": await self._get_last_activity(sandbox),
        }

    async def _get_last_activity(self, sandbox: AsyncSandbox) -> float | None:
        """Most recent Chrome visit time as a unix timestamp, read from the browser history DB.

        Mirrors PodmanBackend's get_container_last_activity: copy the (Chrome-locked) History DB,
        then query it with sqlite3. Requires a running sandbox; returns None otherwise or on error.
        """
        if sandbox.state != "started":
            return None
        command = (
            f"cp {CHROME_HISTORY_PATH} /tmp/cf-history.db && "
            "sqlite3 /tmp/cf-history.db 'select MAX(last_visit_time) from urls;'"
        )
        try:
            response = await sandbox.process.exec(command)
        except Exception as e:
            logger.warning(
                f"Unexpected error fetching last activity for {sandbox.name}: {type(e).__name__}: {e}"
            )
            return None
        output = response.result.strip()
        if response.exit_code != 0 or not output:
            logger.warning(
                f"Failed to fetch last activity for {sandbox.name}: exit={response.exit_code} result={output!r}"
            )
            return None
        try:
            chromium_time = float(output)
        except ValueError:
            return None
        return (chromium_time / 1_000_000) - CHROMIUM_EPOCH_OFFSET_SECONDS

    async def _get(self, name: str) -> AsyncSandbox | None:
        try:
            return await self.client.get(name)
        except DaytonaNotFoundError:
            return None

    async def _create(self, name: str, labels: dict[str, str] | None = None) -> AsyncSandbox:
        params = CreateSandboxFromSnapshotParams(
            snapshot=self.snapshot,
            name=name,
            labels=labels or {LABEL_FLEET: "1"},
            public=False,
            auto_stop_interval=AUTO_STOP_MINUTES,
            # delete after TTL_MINUTES continuously stopped; Daytona owns teardown
            auto_delete_interval=TTL_MINUTES,
        )
        logger.info(f"Creating Daytona sandbox {name} from snapshot {self.snapshot}")
        try:
            return await self.client.create(params, timeout=400)
        except DaytonaConflictError:
            # Lost a concurrent create race (same deterministic name); adopt the winner.
            logger.info(f"Daytona sandbox {name} already exists, adopting")
            existing = await self._get(name)
            if existing is None:
                raise
            return existing
