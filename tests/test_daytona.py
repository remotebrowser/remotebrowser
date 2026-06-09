import asyncio

import pytest

from getgather.config import settings

# DaytonaBackend talks to a live Daytona org and creates real sandboxes, so these tests only
# run when the daytona backend is selected (and require DAYTONA_API_KEY / DAYTONA_SNAPSHOT).
pytestmark = pytest.mark.skipif(
    settings.BROWSER_BACKEND != "daytona",
    reason="DaytonaBackend-only (set BROWSER_BACKEND=daytona)",
)

pytest.importorskip("daytona", reason="install the daytona extra: uv sync --extra daytona")

from getgather.browsers.daytona_browsers import (  # noqa: E402
    AUTO_STOP_MINUTES,
    TTL_MINUTES,
    DaytonaBackend,
    _sandbox_name,  # pyright: ignore[reportPrivateUsage]
)


def make_backend() -> DaytonaBackend:
    return DaytonaBackend(
        settings.DAYTONA_API_KEY, settings.DAYTONA_API_URL, settings.DAYTONA_SNAPSHOT
    )


class TestDaytonaLifecycle:
    browser_ids: list[str] = []

    @pytest.fixture(autouse=True)
    def cleanup(self):
        self.browser_ids = []
        yield

        async def _teardown():
            backend = make_backend()
            for browser_id in self.browser_ids:
                try:
                    await backend.delete_browser(browser_id)
                except Exception:
                    pass
            await backend.shutdown()

        asyncio.run(_teardown())

    def test_create_is_idempotent_and_listed(self):
        browser_id = "test-daytona-01"
        self.browser_ids.append(browser_id)

        async def _run():
            backend = make_backend()
            first = await backend.create_browser(browser_id, None)
            assert first["hostname"] == _sandbox_name(browser_id)
            assert first["cdp_url"]

            second = await backend.create_browser(browser_id, None)
            assert second["hostname"] == first["hostname"]

            assert browser_id in await backend.list_browser_ids()
            assert await backend.browser_exists(browser_id)
            await backend.shutdown()

        asyncio.run(_run())

    def test_delete_removes_sandbox(self):
        browser_id = "test-daytona-02"
        self.browser_ids.append(browser_id)

        async def _run():
            backend = make_backend()
            await backend.create_browser(browser_id, None)
            assert await backend.delete_browser(browser_id) == {"status": "deleted"}
            assert not await backend.browser_exists(browser_id)
            assert await backend.delete_browser(browser_id) == {"status": "not found"}
            await backend.shutdown()

        asyncio.run(_run())
        self.browser_ids.remove(browser_id)

    def test_create_sets_native_lifecycle_intervals(self):
        browser_id = "test-daytona-03"
        self.browser_ids.append(browser_id)

        async def _run():
            backend = make_backend()
            await backend.create_browser(browser_id, None)
            # Teardown is owned by Daytona: the created sandbox carries the lifecycle intervals.
            sandbox = await backend.client.get(_sandbox_name(browser_id))
            assert sandbox.auto_stop_interval == AUTO_STOP_MINUTES
            assert sandbox.auto_delete_interval == TTL_MINUTES
            await backend.shutdown()

        asyncio.run(_run())
