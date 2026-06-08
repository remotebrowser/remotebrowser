import asyncio
from pathlib import Path
from typing import Any, cast

import pytest
from pytest import MonkeyPatch

import getgather.mcp.main as main
from getgather.config import settings
from getgather.mcp.browser import BrowserManager
from getgather.mcp.main import LocationProxyMiddleware


class StubBrowser:
    """Minimal stand-in for zd.Browser: terminate only uses .id and .stop()."""

    def __init__(self, id: str):
        self.id = id
        self.stopped = False

    async def stop(self):
        self.stopped = True


class FakeMessage:
    def __init__(self, name: str):
        self.name = name


class FakeContext:
    def __init__(self, name: str):
        self.message = FakeMessage(name)


@pytest.fixture
def manager(monkeypatch: MonkeyPatch, tmp_path: Path) -> BrowserManager:
    """Isolated browser manager + sandboxed profiles dir for each test."""
    monkeypatch.setattr(settings, "DATA_DIR", str(tmp_path))
    fresh = BrowserManager()
    monkeypatch.setattr(main, "browser_manager", fresh)
    return fresh


def _context(name: str = "amazon_get_purchase_history_with_details") -> Any:
    return cast(Any, FakeContext(name))


# Cast to Any so tests can drive the middleware's internal helpers without
# tripping reportPrivateUsage / CallNext arg-type checks.
def _middleware() -> Any:
    return cast(Any, LocationProxyMiddleware())


class TestCallNextWithTimeout:
    @pytest.mark.asyncio
    async def test_returns_result_when_within_deadline(
        self, manager: BrowserManager, monkeypatch: MonkeyPatch
    ):
        monkeypatch.setattr(settings, "MCP_TOOL_CALL_TIMEOUT", 5)
        manager.set_incognito_browser("sess1", cast(Any, StubBrowser("sess1")))

        async def call_next(_ctx: Any) -> str:
            return "ok"

        result = await _middleware()._call_next_with_timeout(_context(), call_next, "sess1")

        assert result == "ok"
        # A successful call must not tear down the session browser.
        assert manager.has_incognito_browser("sess1")

    @pytest.mark.asyncio
    async def test_times_out_and_releases_browser(
        self, manager: BrowserManager, monkeypatch: MonkeyPatch
    ):
        monkeypatch.setattr(settings, "MCP_TOOL_CALL_TIMEOUT", 0.05)
        browser = StubBrowser("sess1")
        manager.set_incognito_browser("sess1", cast(Any, browser))

        async def call_next(_ctx: Any) -> str:
            await asyncio.sleep(10)
            return "never"

        with pytest.raises(TimeoutError):
            await _middleware()._call_next_with_timeout(_context(), call_next, "sess1")

        assert browser.stopped
        assert not manager.has_incognito_browser("sess1")


class TestReleaseSessionBrowser:
    @pytest.mark.asyncio
    async def test_noop_without_signin_id(self, manager: BrowserManager):
        await _middleware()._release_session_browser(None)

    @pytest.mark.asyncio
    async def test_noop_when_browser_unknown(self, manager: BrowserManager):
        await _middleware()._release_session_browser("missing")
