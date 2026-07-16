from typing import Any, cast

import pytest
from pytest import MonkeyPatch

from getgather.browsers import daytona_browsers
from getgather.browsers.daytona_browsers import DaytonaBackend, ProxyVerificationError


def _backend() -> DaytonaBackend:
    # The AsyncDaytona client is constructed but never touched: every test patches the methods
    # that would reach it (_create_candidate, _cleanup_losers, _get).
    return DaytonaBackend(api_key="test-key", api_url="", snapshot="test-snapshot")


def _patch_proxy(monkeypatch: MonkeyPatch, *, ips: list[str | None], proxy_ok: bool = True) -> None:
    """Force a configured proxy and drive _get_sandbox_public_ip's return sequence."""

    class _Cfg:
        def get_proxy_url(self, browser_id: str) -> str:
            return "http://proxy.example:9999"

    async def fake_get_proxy_config(*args: Any, **kwargs: Any):
        return _Cfg()

    async def fake_configure_sandbox_proxy(*args: Any, **kwargs: Any) -> bool:
        return proxy_ok

    it = iter(ips)

    async def fake_public_ip(*args: Any, **kwargs: Any):
        return next(it)

    monkeypatch.setattr(daytona_browsers, "get_proxy_config", fake_get_proxy_config)
    monkeypatch.setattr(daytona_browsers, "_configure_sandbox_proxy", fake_configure_sandbox_proxy)
    monkeypatch.setattr(daytona_browsers, "_get_sandbox_public_ip", fake_public_ip)


class _Sandbox:
    name = "chromium-test"


def _fake_sandbox() -> "daytona_browsers.AsyncSandbox":
    return cast("daytona_browsers.AsyncSandbox", _Sandbox())


@pytest.mark.asyncio
async def test_configure_remote_sandbox_ok_when_ip_before_missing(monkeypatch: MonkeyPatch) -> None:
    # Regression: a failed ip_before measurement (None) must NOT fail a working proxy.
    _patch_proxy(monkeypatch, ips=[None, "9.9.9.9"])
    await daytona_browsers._configure_remote_sandbox(_fake_sandbox(), "b0", None, None)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.asyncio
async def test_configure_remote_sandbox_raises_on_ip_check_failure(
    monkeypatch: MonkeyPatch,
) -> None:
    # ip_after is None (curl/exec timeout): distinct, accurate error, not "IP unchanged".
    _patch_proxy(monkeypatch, ips=["1.1.1.1", None])
    with pytest.raises(ProxyVerificationError, match="IP check failed"):
        await daytona_browsers._configure_remote_sandbox(_fake_sandbox(), "b0", None, None)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.asyncio
async def test_configure_remote_sandbox_raises_when_ip_unchanged(monkeypatch: MonkeyPatch) -> None:
    _patch_proxy(monkeypatch, ips=["1.1.1.1", "1.1.1.1"])
    with pytest.raises(ProxyVerificationError, match="IP unchanged"):
        await daytona_browsers._configure_remote_sandbox(_fake_sandbox(), "b0", None, None)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.asyncio
async def test_get_browser_never_reconfigures_proxy(monkeypatch: MonkeyPatch) -> None:
    # GET is a cheap read: proxy is configured+verified once on create, never on get, even when
    # x-origin-ip is present. Otherwise every GET restarts tinyproxy and can 500 on an IP-check flake.
    configured = False

    async def fake_configure(*args: Any, **kwargs: Any) -> None:
        nonlocal configured
        configured = True

    async def fake_get(self: Any, name: str):
        return _Sandbox()

    async def fake_info(self: Any, sandbox: Any):
        return {"id": "b0"}

    monkeypatch.setattr(daytona_browsers, "_configure_remote_sandbox", fake_configure)
    monkeypatch.setattr(DaytonaBackend, "_get", fake_get)
    monkeypatch.setattr(DaytonaBackend, "_get_info", fake_info)

    info = await _backend().get_browser("b0", origin_ip="1.2.3.4", target_domain="amazon.com")
    assert info == {"id": "b0"}
    assert configured is False


def test_create_browser_n1_short_circuits_best_of_n(monkeypatch: MonkeyPatch) -> None:
    # The POST /api/v1/browsers endpoint short-circuits the race when N=1: it assigns an id and
    # calls `backend.create_browser` directly. The race helper must not run.
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from getgather.browsers import router as router_module

    monkeypatch.setattr(router_module.settings, "BROWSER_BEST_OF_N", 1)
    monkeypatch.setattr(router_module, "backend", _backend())

    ids = iter(["solo"])

    def fake_new_id() -> str:
        return next(ids)

    called: dict[str, Any] = {}

    async def fake_create_browser(
        self: Any, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, str]:
        called["browser_id"] = browser_id
        return {"id": browser_id}

    async def fail_best_of_n(*args: Any, **kwargs: Any) -> tuple[str, dict[str, Any]]:
        raise AssertionError("best_of_n should not run when N=1")

    monkeypatch.setattr(router_module, "new_browser_id", fake_new_id)
    monkeypatch.setattr(DaytonaBackend, "create_browser", fake_create_browser)
    monkeypatch.setattr(router_module, "best_of_n", fail_best_of_n)

    app = FastAPI()
    app.include_router(router_module.router)
    client = TestClient(app)

    response = client.post("/api/v1/browsers")
    assert response.status_code == 200
    data = response.json()
    assert data == {"browser_id": "solo", "id": "solo"}
    assert called["browser_id"] == "solo"


def test_create_browser_auto_n_gt1_invokes_best_of_n(monkeypatch: MonkeyPatch) -> None:
    # N>1 delegates to the shared best_of_n helper, passing the backend through.
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from getgather.browsers import router as router_module

    monkeypatch.setattr(router_module.settings, "BROWSER_BEST_OF_N", 3)
    monkeypatch.setattr(router_module, "backend", _backend())

    invoked: dict[str, Any] = {}

    async def fake_best_of_n(
        backend: Any, n: int, origin_ip: str | None, target_domain: str | None
    ) -> tuple[str, dict[str, str]]:
        invoked["n"] = n
        invoked["origin_ip"] = origin_ip
        invoked["target_domain"] = target_domain
        return "winner", {"id": "winner"}

    monkeypatch.setattr(router_module, "best_of_n", fake_best_of_n)

    app = FastAPI()
    app.include_router(router_module.router)
    client = TestClient(app)

    response = client.post(
        "/api/v1/browsers", headers={"x-origin-ip": "1.2.3.4", "x-target-domains": "amazon.com"}
    )
    assert response.status_code == 200
    assert response.json() == {"browser_id": "winner", "id": "winner"}
    assert invoked == {"n": 3, "origin_ip": "1.2.3.4", "target_domain": "amazon.com"}


class _ExecResult:
    def __init__(self, exit_code: int, result: str = "") -> None:
        self.exit_code = exit_code
        self.result = result


class _Process:
    def __init__(self, responses: dict[str, _ExecResult]) -> None:
        self._responses = responses
        self.calls: list[str] = []

    async def exec(self, cmd: str) -> _ExecResult:
        self.calls.append(cmd)
        for key, res in self._responses.items():
            if key in cmd:
                return res
        return _ExecResult(0, "")


class _SwitchSandbox:
    def __init__(self, responses: dict[str, _ExecResult]) -> None:
        self.name = "chromium-test"
        self.process = _Process(responses)


@pytest.mark.asyncio
async def test_select_browser_prestart_writes_active_browser_file() -> None:
    sandbox = _SwitchSandbox({"tee": _ExecResult(0, "cloak")})
    await daytona_browsers._select_browser_prestart(  # pyright: ignore[reportPrivateUsage]
        cast("daytona_browsers.AsyncSandbox", sandbox), "cloak"
    )
    assert any(
        "echo cloak" in c and "/home/user/.active-browser" in c for c in sandbox.process.calls
    )
    assert not any("switch-browser" in c for c in sandbox.process.calls)  # single boot, no swap


@pytest.mark.asyncio
async def test_select_browser_prestart_raises_when_write_fails() -> None:
    sandbox = _SwitchSandbox({"tee": _ExecResult(1, "permission denied")})
    with pytest.raises(RuntimeError, match="pre-start"):
        await daytona_browsers._select_browser_prestart(  # pyright: ignore[reportPrivateUsage]
            cast("daytona_browsers.AsyncSandbox", sandbox), "cloak"
        )


@pytest.mark.asyncio
async def test_switch_browser_live_execs_switch_and_waits_for_cdp() -> None:
    sandbox = _SwitchSandbox({
        ".active-browser": _ExecResult(0, "chrome"),  # not yet on cloak
        "switch-browser cloak": _ExecResult(0, ""),
        "json/version": _ExecResult(0, ""),  # CDP ready
    })
    await daytona_browsers._switch_browser_live(  # pyright: ignore[reportPrivateUsage]
        cast("daytona_browsers.AsyncSandbox", sandbox), "cloak"
    )
    assert any("sudo switch-browser cloak" in c for c in sandbox.process.calls)
    assert any("json/version" in c for c in sandbox.process.calls)  # CDP re-waited


@pytest.mark.asyncio
async def test_switch_browser_live_skips_when_already_cloak() -> None:
    sandbox = _SwitchSandbox({".active-browser": _ExecResult(0, "cloak")})
    await daytona_browsers._switch_browser_live(  # pyright: ignore[reportPrivateUsage]
        cast("daytona_browsers.AsyncSandbox", sandbox), "cloak"
    )
    assert not any("switch-browser" in c for c in sandbox.process.calls)


@pytest.mark.asyncio
async def test_switch_browser_live_raises_when_switch_fails() -> None:
    sandbox = _SwitchSandbox({
        ".active-browser": _ExecResult(0, "chrome"),
        "switch-browser cloak": _ExecResult(1, "CloakBrowser not available (amd64 only)"),
    })
    with pytest.raises(RuntimeError, match="switch-browser cloak failed"):
        await daytona_browsers._switch_browser_live(  # pyright: ignore[reportPrivateUsage]
            cast("daytona_browsers.AsyncSandbox", sandbox), "cloak"
        )
