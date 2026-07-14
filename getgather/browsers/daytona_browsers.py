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

from getgather.browsers.backend import BROWSER_NAME_PREFIX, BrowserNotFound, new_browser_id
from getgather.browsers.residential_proxy import get_proxy_config
from getgather.config import settings

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
) -> bool:
    """Apply the residential proxy to the sandbox and verify egress IP changed.

    Returns True if the proxy is verified (or none is required), False if the proxy failed to
    apply or the egress IP was unchanged. Best-of-N uses this to pick a proxy-verified winner."""
    proxy_config = await get_proxy_config(origin_ip, target_domain, settings)
    proxy_url = proxy_config.get_proxy_url(browser_id) if proxy_config else None

    if not proxy_url:
        return True  # no proxy required; nothing to verify

    ip_before = await _get_sandbox_public_ip(sandbox)
    logger.debug(f"Sandbox {sandbox.name} IP before proxy: {ip_before}")

    ok = await _configure_sandbox_proxy(sandbox, proxy_url)
    if not ok:
        return False

    ip_after = await _get_sandbox_public_ip(sandbox)
    if ip_before and ip_after and ip_before != ip_after:
        logger.info(f"Sandbox {sandbox.name} IP changed: {ip_before} -> {ip_after}")
        return True
    logger.warning(f"Sandbox {sandbox.name} IP unchanged after proxy: {ip_before}")
    return False


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

    async def shutdown(self) -> None:
        await self.client.close()

    async def create_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        lock = self._locks.setdefault(browser_id, asyncio.Lock())
        async with lock:
            sandbox = await self._ensure(browser_id)
            if not await _configure_remote_sandbox(sandbox, browser_id, origin_ip, target_domain):
                logger.warning(f"Proxy not verified for {browser_id}; returning sandbox anyway")
            return await self._get_info(sandbox)

    async def create_browser_auto(
        self, origin_ip: str | None, target_domain: str | None
    ) -> tuple[str, dict[str, Any]]:
        n = max(1, settings.DAYTONA_BEST_OF_N)
        if n == 1:
            browser_id = new_browser_id()
            return browser_id, await self.create_browser(browser_id, origin_ip, target_domain)
        return await self._best_of_n(n, origin_ip, target_domain)

    async def get_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        sandbox = await self._get(_sandbox_name(browser_id))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if origin_ip and not await _configure_remote_sandbox(
            sandbox, browser_id, origin_ip, target_domain
        ):
            logger.warning(f"Proxy not verified for {browser_id}; returning sandbox anyway")
        return await self._get_info(sandbox)

    async def delete_browser(self, browser_id: str) -> dict[str, Any]:
        name = _sandbox_name(browser_id)
        sandbox = await self._get(name)
        self._locks.pop(browser_id, None)
        if sandbox is None:
            return {"status": "not found"}
        await sandbox.delete()
        return {"status": "deleted"}

    async def browser_exists(self, browser_id: str) -> bool:
        return await self._get(_sandbox_name(browser_id)) is not None

    async def list_browser_ids(self) -> list[str]:
        browser_ids: list[str] = []
        async for sandbox in self.client.list(ListSandboxesQuery(labels={LABEL_FLEET: "1"})):
            # A just-deleted sandbox lingers briefly as `DESTROYED_<name>_<ts>`; only our names count.
            if sandbox.name and sandbox.name.startswith(BROWSER_NAME_PREFIX):
                browser_ids.append(_browser_id_from_name(sandbox.name))
        return browser_ids

    async def cleanup_idle(self) -> list[str]:
        # Teardown is owned by Daytona's native auto_stop_interval + auto_delete_interval (set in
        # _create), so there is no reconcile sweep to run here.
        return []

    async def get_cdp_base_url(self, browser_id: str) -> str:
        sandbox = await self._get(_sandbox_name(browser_id))
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
        sandbox = await self._get(_sandbox_name(browser_id))
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

    async def _best_of_n(
        self, n: int, origin_ip: str | None, target_domain: str | None
    ) -> tuple[str, dict[str, Any]]:
        """Race n cold-create candidates; keep the first proxy-verified one, delete the rest.

        Each candidate is an independent browser with its own server-assigned id (so their sandbox
        names never collide). The first candidate that starts AND passes proxy verification wins;
        if none verify their proxy, the fastest that merely started is the fallback. Losers are
        torn down in the background."""
        ids = [new_browser_id() for _ in range(n)]
        logger.info(f"Best-of-{n} sandbox race: {ids}")
        tasks = [
            asyncio.create_task(self._create_candidate(b, origin_ip, target_domain)) for b in ids
        ]
        winner: tuple[str, dict[str, Any]] | None = None
        fallback: tuple[str, dict[str, Any]] | None = None
        for coro in asyncio.as_completed(tasks):
            try:
                browser_id, info, proxy_ok = await coro
            except Exception as e:
                logger.warning(f"Best-of-N candidate failed: {type(e).__name__}: {e}")
                continue
            if proxy_ok:
                winner = (browser_id, info)
                break
            if fallback is None:
                fallback = (browser_id, info)

        for task in tasks:
            if not task.done():
                task.cancel()

        result = winner or fallback
        if result is None:
            raise RuntimeError("Best-of-N: all sandbox candidates failed to start")
        if winner is None:
            logger.warning(f"Best-of-N: no proxy-verified candidate, falling back to {result[0]}")
        logger.info(f"Best-of-N winner: {result[0]}")
        asyncio.create_task(self._cleanup_losers(ids, winner_id=result[0]))
        return result

    async def _create_candidate(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> tuple[str, dict[str, Any], bool]:
        sandbox = await self._create(_sandbox_name(browser_id))
        if sandbox.state != "started":
            await sandbox.start()
        proxy_ok = await _configure_remote_sandbox(sandbox, browser_id, origin_ip, target_domain)
        return browser_id, await self._get_info(sandbox), proxy_ok

    async def _cleanup_losers(self, ids: list[str], *, winner_id: str) -> None:
        for browser_id in ids:
            if browser_id == winner_id:
                continue
            self._locks.pop(browser_id, None)
            # A cancelled candidate's sandbox may still be materializing server-side: it can be
            # not-yet-visible, or visible but mid state-change (delete rejected with "state change
            # in progress"). Retry both cases until it settles, so we don't leak it (Daytona's
            # auto_delete_interval is the final backstop).
            deleted = False
            for _ in range(8):
                sandbox = await self._get(_sandbox_name(browser_id))
                if sandbox is None:
                    await asyncio.sleep(5)
                    continue
                try:
                    await sandbox.delete()
                    logger.info(f"Best-of-N: deleted losing candidate {browser_id}")
                    deleted = True
                    break
                except Exception as e:
                    logger.debug(f"Best-of-N: delete retry for loser {browser_id}: {e}")
                    await asyncio.sleep(5)
            if not deleted:
                logger.warning(f"Best-of-N: gave up deleting loser {browser_id} (will auto-delete)")

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

    async def _create(self, name: str) -> AsyncSandbox:
        params = CreateSandboxFromSnapshotParams(
            snapshot=self.snapshot,
            name=name,
            labels={LABEL_FLEET: "1"},
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
