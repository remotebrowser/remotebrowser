from typing import Any, Protocol, runtime_checkable

from getgather.config import settings

# Shared name prefix: a browser with id `abc` is a podman container / Daytona sandbox named
# `chromium-abc`. Both local backends derive names and parse ids from this single prefix.
BROWSER_NAME_PREFIX = "chromium-"


class BrowserNotFound(Exception):
    """Raised by a backend when a browser does not exist; endpoints map it to HTTP 404."""


@runtime_checkable
class Backend(Protocol):
    """A backend creates a browser on demand and tears it down afterwards.

    Three implementations select at startup via `create_backend()`:
    - `FleetBackend`: proxy the REST API to an external Chrome Fleet (`CHROMEFLEET_URL`).
    - `DaytonaBackend`: on-demand Daytona sandboxes (`BROWSER_BACKEND=daytona`).
    - `PodmanBackend`: local podman containers (default).

    The browser API endpoints and the CDP/VNC websocket proxies in `router.py` depend only on
    these methods.
    """

    async def shutdown(self) -> None: ...

    async def create_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]: ...

    async def get_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]: ...

    async def delete_browser(self, browser_id: str) -> dict[str, Any]: ...

    async def list_browser_ids(self) -> list[str]: ...

    async def browser_exists(self, browser_id: str) -> bool: ...

    async def cleanup_idle(self) -> list[str]: ...

    async def get_cdp_base_url(self, browser_id: str) -> str: ...

    def cdp_websocket_base(self) -> str | None: ...

    async def get_vnc_endpoint(self, browser_id: str) -> tuple[str, int] | None: ...

    async def get_live_view_url(self, browser_id: str) -> str | None: ...


def create_backend() -> Backend:
    if settings.CHROMEFLEET_URL:
        from getgather.browsers.fleet_browsers import FleetBackend

        return FleetBackend()

    if settings.BROWSER_BACKEND == "daytona":
        from getgather.browsers.daytona_browsers import DaytonaBackend

        return DaytonaBackend(
            settings.DAYTONA_API_KEY, settings.DAYTONA_API_URL, settings.DAYTONA_SNAPSHOT
        )

    from getgather.browsers.podman_browsers import PodmanBackend

    return PodmanBackend()
