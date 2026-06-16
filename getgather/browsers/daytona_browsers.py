import asyncio
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

from getgather.browsers.backend import BROWSER_NAME_PREFIX, BrowserNotFound
from getgather.browsers.residential_proxy import (
    GeoLocation,
    MassiveProxy,
    OxylabsProxy,
    get_location,
)
from getgather.config import settings

CDP_PORT = 9222

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
# Treat cdp_url as a bearer secret. The token is stateless and survives sandbox restarts, so we
# mint one per get_info (no cache) with a generous TTL so it outlives a browser session.
SIGNED_URL_TTL_SECONDS = 3600

LABEL_FLEET = "fleet"


def _sandbox_name(browser_id: str) -> str:
    return f"{BROWSER_NAME_PREFIX}{browser_id}"


def _browser_id_from_name(name: str) -> str:
    return name.removeprefix(BROWSER_NAME_PREFIX)


async def _set_upstream(sandbox: AsyncSandbox, proxy_url: str) -> None:
    stripped = proxy_url.removeprefix("http://")
    cmds = [
        "sed -i '/^Upstream http/d' /app/tinyproxy.conf",
        f"sed -i '$ a\\Upstream http {stripped}' /app/tinyproxy.conf",
        "pkill tinyproxy || true; tinyproxy -d -c /app/tinyproxy.conf &",
    ]
    for cmd in cmds:
        response = await sandbox.process.exec(cmd)
        if response.exit_code != 0:
            logger.warning(
                f"tinyproxy setup cmd failed (exit {response.exit_code}): {cmd!r}: {response.result.strip()!r}"
            )


async def _sandbox_public_ip(
    sandbox: AsyncSandbox, *, retries: int = 5, retry_delay: float = 2.0
) -> str | None:
    for attempt in range(1, retries + 1):
        try:
            response = await sandbox.process.exec(
                "curl -s --max-time 10 --proxy http://127.0.0.1:8119 https://ip.fly.dev"
            )
            ip = response.result.strip() or None
            if ip:
                return ip
            logger.debug(f"IP check attempt {attempt}/{retries} in {sandbox.name}: empty response")
        except Exception as e:
            logger.debug(f"IP check attempt {attempt}/{retries} in {sandbox.name} failed: {e}")
        if attempt < retries:
            await asyncio.sleep(retry_delay)
    logger.warning(f"IP check in {sandbox.name} failed after {retries} attempts")
    return None


async def _configure_proxy_in_sandbox(
    sandbox: AsyncSandbox,
    browser_id: str,
    origin_ip: str | None,
) -> str | None:
    if origin_ip and not settings.MAXMIND_ENABLED:
        logger.warning(
            f"x-origin-ip={origin_ip} provided but MaxMind is not configured (missing MAXMIND_ACCOUNT_ID/MAXMIND_LICENSE_KEY) — location will not be resolved"
        )

    provider_name = settings.DEFAULT_PROXY_TYPE
    if provider_name == "oxylabs" and not settings.OXYLABS_PROXY_ENABLED:
        provider_name = "massive"
    elif provider_name == "massive" and not settings.MASSIVE_PROXY_ENABLED:
        provider_name = "oxylabs"

    if provider_name == "oxylabs" and settings.OXYLABS_PROXY_ENABLED:
        proxy_cls: type[OxylabsProxy] | type[MassiveProxy] | None = OxylabsProxy
        proxy_user, proxy_pw = settings.OXYLABS_USERNAME, settings.OXYLABS_PASSWORD
    elif provider_name == "massive" and settings.MASSIVE_PROXY_ENABLED:
        proxy_cls = MassiveProxy
        proxy_user, proxy_pw = settings.MASSIVE_PROXY_USERNAME, settings.MASSIVE_PROXY_PASSWORD
    else:
        proxy_cls = None
        proxy_user = proxy_pw = ""

    if origin_ip and proxy_cls is None:
        logger.warning(
            f"x-origin-ip={origin_ip} provided but no residential proxy is configured — proxy will not be set"
        )

    proxy_url: str | None = None
    if proxy_cls is not None:
        location: GeoLocation | None = None

        if origin_ip:
            if settings.MAXMIND_ENABLED:
                logger.debug(f"Looking up location for x-origin-ip={origin_ip}")
                location = await get_location(
                    origin_ip, settings.MAXMIND_ACCOUNT_ID, settings.MAXMIND_LICENSE_KEY
                )
                if location:
                    logger.info(
                        f"MaxMind resolved {origin_ip} -> country={location.country} subdivision={location.subdivision} city={location.city}"
                    )
                else:
                    logger.warning(f"MaxMind returned no location for x-origin-ip={origin_ip}")

        if location:
            proxy_url = proxy_cls.format_url(
                location,
                session_id=browser_id,
                username=proxy_user,
                password=proxy_pw,
            )
            logger.debug(
                f"Generated {provider_name} proxy_url for browser {browser_id}: {proxy_url}"
            )

    ip_before = await _sandbox_public_ip(sandbox)
    logger.debug(f"Browser {browser_id} IP before applying config: {ip_before}")

    if proxy_url:
        await _set_upstream(sandbox, proxy_url)
        ip_after = await _sandbox_public_ip(sandbox)
        if ip_before and ip_after:
            if ip_before != ip_after:
                logger.info(f"Browser {browser_id} IP changed: {ip_before} -> {ip_after}")
            else:
                logger.warning(
                    f"Browser {browser_id} IP unchanged after proxy configuration: {ip_before}"
                )
        return ip_after
    return ip_before


class DaytonaBackend:
    """Launch a Daytona sandbox per browser on demand (no pool).

    The browser_id -> sandbox mapping is the deterministic sandbox name plus labels, so there is
    no local state. CDP is reached over a Daytona signed preview URL: a public, internet-reachable,
    self-authenticating HTTPS reverse proxy to port 9222 (no inbound networking into the sandbox is
    required). VNC is podman-only; CDP is reached over an HTTPS signed preview URL. Residential
    proxy / geo-IP works here when configured.

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

    async def create_browser(self, browser_id: str, origin_ip: str | None) -> dict[str, Any]:
        lock = self._locks.setdefault(browser_id, asyncio.Lock())
        async with lock:
            sandbox = await self._ensure(browser_id)
            ip = await _configure_proxy_in_sandbox(sandbox, browser_id, origin_ip)
            return await self._get_info(sandbox, ip_address=ip)

    async def get_browser(self, browser_id: str, origin_ip: str | None) -> dict[str, Any]:
        sandbox = await self._get(_sandbox_name(browser_id))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if origin_ip:
            ip = await _configure_proxy_in_sandbox(sandbox, browser_id, origin_ip)
        else:
            ip = await _sandbox_public_ip(sandbox)
        return await self._get_info(sandbox, ip_address=ip)

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
        return None  # no VNC: the sandbox is reached over an HTTPS signed URL, not a raw TCP port

    async def _ensure(self, browser_id: str) -> AsyncSandbox:
        name = _sandbox_name(browser_id)
        sandbox = await self._get(name)
        if sandbox is None:
            sandbox = await self._create(name)

        if sandbox.state != "started":
            logger.info(f"Starting Daytona sandbox {name} (state={sandbox.state})")
            await sandbox.start()

        return sandbox

    async def _get_info(
        self, sandbox: AsyncSandbox, *, ip_address: str | None = None
    ) -> dict[str, Any]:
        signed = await sandbox.create_signed_preview_url(
            CDP_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        return {
            "hostname": sandbox.name,
            "ip_address": ip_address,
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
