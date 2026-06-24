import asyncio
import time
from typing import Any
from uuid import uuid4

from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    CreateSandboxFromSnapshotParams,
    DaytonaConfig,
    DaytonaNotFoundError,
    ListSandboxesQuery,
)
from loguru import logger

from getgather.browsers.backend import BROWSER_NAME_PREFIX, BrowserNotFound
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
LABEL_BROWSER_ID = "browser_id"


def _random_sandbox_name(browser_id: str) -> str:
    return f"{BROWSER_NAME_PREFIX}{browser_id}-{uuid4().hex[:8]}"


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


class DaytonaBackend:
    """Launch a Daytona sandbox per browser on demand (no pool).

    Identity is label-based: all sandboxes carry labels `fleet=1` and `browser_id=<id>`.
    Names are random (cosmetic prefix + uuid suffix) so N candidates can coexist during
    best-of-N cold-create. CDP is reached over a Daytona signed preview URL: a public,
    internet-reachable, self-authenticating HTTPS reverse proxy to port 9222. Live view
    embeds noVNC on port 8080 via a signed preview URL. Residential proxy/geo-IP are
    supported via tinyproxy (preconfigured in the snapshot, same as podman).

    Sandbox teardown is owned by Daytona: auto_stop_interval stops idle sandboxes and
    auto_delete_interval deletes them once continuously stopped past the TTL (both set at
    create time in _create). Best-of-N loser teardown is fire-and-forget via asyncio task.
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
            # Pre-create check: if a started sandbox already exists, configure and return.
            existing = await self._get(browser_id)
            if existing is not None and existing.state == "started":
                try:
                    await _configure_remote_sandbox(existing, browser_id, origin_ip, target_domain)
                except ProxyVerificationError as e:
                    logger.warning(str(e))
                return await self._get_info(existing)

            n = settings.DAYTONA_BEST_OF_N
            if n > 1:
                sandbox = await self._best_of_n(browser_id, origin_ip, target_domain)
            else:
                sandbox = await self._ensure(browser_id)
                try:
                    await _configure_remote_sandbox(sandbox, browser_id, origin_ip, target_domain)
                except ProxyVerificationError as e:
                    logger.warning(str(e))

            return await self._get_info(sandbox)

    async def get_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        sandbox = await self._get(browser_id)
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if origin_ip:
            try:
                await _configure_remote_sandbox(sandbox, browser_id, origin_ip, target_domain)
            except ProxyVerificationError as e:
                logger.warning(str(e))
        return await self._get_info(sandbox)

    async def delete_browser(self, browser_id: str) -> dict[str, Any]:
        sandbox = await self._get(browser_id)
        self._locks.pop(browser_id, None)
        if sandbox is None:
            return {"status": "not found"}
        await sandbox.delete()
        return {"status": "deleted"}

    async def browser_exists(self, browser_id: str) -> bool:
        return await self._get(browser_id) is not None

    async def list_browser_ids(self) -> list[str]:
        browser_ids: list[str] = []
        seen: set[str] = set()
        async for sandbox in self.client.list(ListSandboxesQuery(labels={LABEL_FLEET: "1"})):
            labels = sandbox.labels or {}
            bid = labels.get(LABEL_BROWSER_ID)
            if bid and bid not in seen:
                seen.add(bid)
                browser_ids.append(bid)
        return browser_ids

    async def cleanup_idle(self) -> list[str]:
        # Teardown is owned by Daytona's native auto_stop_interval + auto_delete_interval (set in
        # _create), so there is no reconcile sweep to run here.
        return []

    async def get_cdp_base_url(self, browser_id: str) -> str:
        sandbox = await self._get(browser_id)
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
        sandbox = await self._get(browser_id)
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
        sandbox = await self._get(browser_id)
        if sandbox is None:
            sandbox = await self._create(browser_id)

        if sandbox.state != "started":
            logger.info(f"Starting Daytona sandbox {sandbox.name} (state={sandbox.state})")
            await sandbox.start()

        return sandbox

    async def _best_of_n(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> AsyncSandbox:
        n = settings.DAYTONA_BEST_OF_N
        handles: list[AsyncSandbox] = []
        # (loop_time, sandbox) — for proxy-fail fallback; populated once sandbox reaches started
        started_at: list[tuple[float, AsyncSandbox]] = []

        async def candidate() -> AsyncSandbox:
            sandbox = await self._create(browser_id)
            handles.append(sandbox)
            await sandbox.start()
            started_at.append((asyncio.get_running_loop().time(), sandbox))
            await _configure_remote_sandbox(sandbox, browser_id, origin_ip, target_domain)
            return sandbox

        tasks: set[asyncio.Task[AsyncSandbox]] = {
            asyncio.create_task(candidate()) for _ in range(n)
        }
        winner: AsyncSandbox | None = None
        pending = set(tasks)

        while pending and winner is None:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if not task.cancelled() and task.exception() is None:
                    winner = task.result()
                    for t in pending:
                        t.cancel()
                    break

        if winner is None:
            if not handles:
                raise RuntimeError(
                    f"Best-of-{n}: all candidates failed to create for browser_id={browser_id}"
                )
            if not started_at:
                raise RuntimeError(
                    f"Best-of-{n}: all candidates failed to start for browser_id={browser_id}"
                )
            started_at.sort(key=lambda x: x[0])
            winner = started_at[0][1]
            logger.warning(
                f"Best-of-{n}: all proxy verifications failed for {browser_id}; "
                f"falling back to fastest started: {winner.name}"
            )

        winner_name = winner.name
        logger.info(
            f"Best-of-{n} winner for {browser_id}: {winner_name}; "
            f"scheduling teardown for {[s.name for s in handles if s.name != winner_name]}"
        )
        asyncio.create_task(self._teardown_losers(browser_id, winner_name, list(handles)))

        return winner

    async def _teardown_losers(
        self, browser_id: str, winner_name: str, handles: list[AsyncSandbox]
    ) -> None:
        losers = [s for s in handles if s.name != winner_name]

        async def _delete_one(sandbox: AsyncSandbox) -> None:
            try:
                await sandbox.delete()
                logger.info(f"Deleted loser sandbox {sandbox.name}")
            except Exception as e:
                logger.warning(
                    f"Failed to delete loser sandbox {sandbox.name}: {type(e).__name__}: {e}"
                )

        await asyncio.gather(*(_delete_one(s) for s in losers), return_exceptions=True)

        # Post-winner reconcile: re-query by label; delete any non-winner sandbox regardless of state.
        # Catches sandboxes created but cancelled before appending to handles.
        try:
            orphans: list[AsyncSandbox] = []
            async for sandbox in self.client.list(
                ListSandboxesQuery(labels={LABEL_FLEET: "1", LABEL_BROWSER_ID: browser_id})
            ):
                if sandbox.name != winner_name:
                    orphans.append(sandbox)
            logger.debug(
                f"Reconcile sweep for {browser_id}: winner={winner_name} "
                f"orphans={[s.name for s in orphans]}"
            )
            for s in orphans:
                try:
                    await s.delete()
                    logger.info(f"Reconcile deleted orphan {s.name}")
                except Exception as e:
                    logger.warning(f"Reconcile delete failed for {s.name}: {type(e).__name__}: {e}")
        except Exception as e:
            logger.warning(
                f"Label reconcile sweep failed for {browser_id}: {type(e).__name__}: {e}"
            )

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

    async def _get(self, browser_id: str) -> AsyncSandbox | None:
        candidates: list[AsyncSandbox] = []
        try:
            async for sandbox in self.client.list(
                ListSandboxesQuery(labels={LABEL_FLEET: "1", LABEL_BROWSER_ID: browser_id})
            ):
                candidates.append(sandbox)
        except DaytonaNotFoundError:
            return None
        if not candidates:
            return None
        started = [s for s in candidates if s.state == "started"]
        pool = started if started else candidates
        pool.sort(key=lambda s: (s.created_at is None, s.created_at))
        return pool[0]

    async def _create(self, browser_id: str) -> AsyncSandbox:
        name = _random_sandbox_name(browser_id)
        params = CreateSandboxFromSnapshotParams(
            snapshot=self.snapshot,
            name=name,
            labels={LABEL_FLEET: "1", LABEL_BROWSER_ID: browser_id},
            public=False,
            auto_stop_interval=AUTO_STOP_MINUTES,
            # delete after TTL_MINUTES continuously stopped; Daytona owns teardown
            auto_delete_interval=TTL_MINUTES,
        )
        logger.info(f"Creating Daytona sandbox {name} for browser {browser_id}")
        return await self.client.create(params, timeout=400)
