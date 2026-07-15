import asyncio
from typing import Any

import pytest
from pytest import MonkeyPatch

from getgather.browsers import daytona_browsers
from getgather.browsers.daytona_browsers import DaytonaBackend, ProxyVerificationError


def _backend() -> DaytonaBackend:
    # The AsyncDaytona client is constructed but never touched: every test patches the methods
    # that would reach it (_create_candidate, _cleanup_losers, _get).
    return DaytonaBackend(api_key="test-key", api_url="", snapshot="test-snapshot")


def _patch_ids(monkeypatch: MonkeyPatch, ids: list[str]) -> None:
    it = iter(ids)
    monkeypatch.setattr(daytona_browsers, "new_browser_id", lambda: next(it))


@pytest.mark.asyncio
async def test_best_of_n_picks_first_to_complete(monkeypatch: MonkeyPatch) -> None:
    _patch_ids(monkeypatch, ["b0", "b1", "b2"])

    # b1 finishes first but its proxy fails (raises); b0 completes next -> b0 wins.
    async def fake_candidate(self: Any, browser_id: str, origin_ip: Any, target_domain: Any):
        delays = {"b0": 0.02, "b1": 0.01, "b2": 0.05}
        await asyncio.sleep(delays[browser_id])
        if browser_id == "b1":
            raise ProxyVerificationError("proxy unchanged")
        return browser_id, {"id": browser_id}

    cleaned: dict[str, Any] = {}

    async def fake_cleanup(self: Any, ids: list[str], *, winner_id: str):
        cleaned["ids"] = ids
        cleaned["winner_id"] = winner_id

    monkeypatch.setattr(DaytonaBackend, "_create_candidate", fake_candidate)
    monkeypatch.setattr(DaytonaBackend, "_cleanup_losers", fake_cleanup)

    winner_id, info = await _backend()._best_of_n(3, None, None)  # pyright: ignore[reportPrivateUsage]
    await asyncio.sleep(0)  # let the fire-and-forget cleanup task run

    assert winner_id == "b0"
    assert info == {"id": "b0"}
    assert cleaned == {"ids": ["b0", "b1", "b2"], "winner_id": "b0"}


@pytest.mark.asyncio
async def test_best_of_n_raises_when_no_proxy_verified(monkeypatch: MonkeyPatch) -> None:
    # Proxy is mandatory: if every candidate fails verification, best-of-N raises instead of
    # returning an unproxied browser, so the client can retry.
    _patch_ids(monkeypatch, ["b0", "b1"])

    async def fake_candidate(self: Any, browser_id: str, origin_ip: Any, target_domain: Any):
        raise ProxyVerificationError("IP unchanged after proxy")

    async def fake_cleanup(self: Any, ids: list[str], *, winner_id: str):
        return None

    monkeypatch.setattr(DaytonaBackend, "_create_candidate", fake_candidate)
    monkeypatch.setattr(DaytonaBackend, "_cleanup_losers", fake_cleanup)

    with pytest.raises(ProxyVerificationError, match="no sandbox candidate started"):
        await _backend()._best_of_n(2, None, None)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.asyncio
async def test_best_of_n_raises_when_all_candidates_fail(monkeypatch: MonkeyPatch) -> None:
    _patch_ids(monkeypatch, ["b0", "b1"])

    async def fake_candidate(self: Any, browser_id: str, origin_ip: Any, target_domain: Any):
        raise RuntimeError("boom")

    async def fake_cleanup(self: Any, ids: list[str], *, winner_id: str):
        return None

    monkeypatch.setattr(DaytonaBackend, "_create_candidate", fake_candidate)
    monkeypatch.setattr(DaytonaBackend, "_cleanup_losers", fake_cleanup)

    with pytest.raises(ProxyVerificationError, match="no sandbox candidate started"):
        await _backend()._best_of_n(2, None, None)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.asyncio
async def test_create_browser_auto_n1_uses_single_path(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(daytona_browsers.settings, "DAYTONA_BEST_OF_N", 1)
    _patch_ids(monkeypatch, ["solo"])

    called: dict[str, Any] = {}

    async def fake_create_browser(self: Any, browser_id: str, origin_ip: Any, target_domain: Any):
        called["browser_id"] = browser_id
        return {"id": browser_id}

    async def fail_best_of_n(*args: Any, **kwargs: Any):
        raise AssertionError("best-of-N should not run when N=1")

    monkeypatch.setattr(DaytonaBackend, "create_browser", fake_create_browser)
    monkeypatch.setattr(DaytonaBackend, "_best_of_n", fail_best_of_n)

    winner_id, info = await _backend().create_browser_auto(None, None)
    assert winner_id == "solo"
    assert info == {"id": "solo"}
    assert called["browser_id"] == "solo"


@pytest.mark.asyncio
async def test_cleanup_losers_deletes_all_but_winner(monkeypatch: MonkeyPatch) -> None:
    deleted: list[str] = []

    class FakeSandbox:
        def __init__(self, name: str) -> None:
            self.name = name

        async def delete(self) -> None:
            deleted.append(self.name)

    async def fake_get(self: Any, name: str):
        return FakeSandbox(name)

    monkeypatch.setattr(DaytonaBackend, "_get", fake_get)

    backend = _backend()
    backend._locks["w"] = asyncio.Lock()  # pyright: ignore[reportPrivateUsage]
    backend._locks["l1"] = asyncio.Lock()  # pyright: ignore[reportPrivateUsage]

    await backend._cleanup_losers(["w", "l1", "l2"], winner_id="w")  # pyright: ignore[reportPrivateUsage]

    assert deleted == ["chromium-l1", "chromium-l2"]
    assert "w" in backend._locks  # winner's lock preserved  # pyright: ignore[reportPrivateUsage]
    assert "l1" not in backend._locks  # pyright: ignore[reportPrivateUsage]
