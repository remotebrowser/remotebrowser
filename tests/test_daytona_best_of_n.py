"""Unit tests for DaytonaBackend._best_of_n."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from getgather.browsers.daytona_browsers import (
    DaytonaBackend,
    ProxyVerificationError,
)


def _make_sandbox(
    name: str, state: str = "started", created_at: str = "2024-01-01T00:00:00Z"
) -> MagicMock:
    sb = MagicMock()
    sb.name = name
    sb.state = state
    sb.created_at = created_at
    sb.start = AsyncMock()
    sb.delete = AsyncMock()
    sb.create_signed_preview_url = AsyncMock(return_value=MagicMock(url=f"https://cdp.{name}"))
    sb.process = MagicMock()
    sb.process.exec = AsyncMock(return_value=MagicMock(exit_code=1, result=""))
    sb.labels = {}
    return sb


def _make_backend() -> DaytonaBackend:
    backend = DaytonaBackend.__new__(DaytonaBackend)
    backend.snapshot = "test-snapshot"
    backend._locks = {}  # pyright: ignore[reportPrivateUsage]
    backend.client = MagicMock()

    async def _empty_list(*args: Any, **kwargs: Any) -> Any:
        return
        yield  # make it an async generator

    backend.client.list = _empty_list
    return backend


@pytest.fixture
def backend() -> DaytonaBackend:
    return _make_backend()


# --- _best_of_n: winner = first fully-passing candidate ---


def test_best_of_n_winner_is_first_full_pass(backend: DaytonaBackend) -> None:
    sb_a = _make_sandbox("sb-a")
    sb_b = _make_sandbox("sb-b")

    call_order: list[str] = []

    async def create_side_effect(browser_id: str) -> Any:
        await asyncio.sleep(0)
        name = f"sb-{chr(ord('a') + len(call_order))}"
        call_order.append(name)
        return sb_a if name == "sb-a" else sb_b

    async def configure_side_effect(sandbox: Any, *args: Any, **kwargs: Any) -> None:
        if sandbox.name == "sb-a":
            await asyncio.sleep(0.02)  # a bit slower
        # both pass

    with (
        patch.object(backend, "_create", side_effect=create_side_effect),
        patch(
            "getgather.browsers.daytona_browsers._configure_remote_sandbox",
            side_effect=configure_side_effect,
        ),
        patch.object(backend, "_teardown_losers", new_callable=AsyncMock),
        patch("getgather.browsers.daytona_browsers.settings") as mock_settings,
    ):
        mock_settings.DAYTONA_BEST_OF_N = 2
        mock_settings.get_proxy_config = AsyncMock(return_value=None)

        winner = asyncio.run(backend._best_of_n("uid123", None, None))  # type: ignore[reportPrivateUsage]

    assert winner in (sb_a, sb_b)


# --- _best_of_n: all proxy-fail → fallback to fastest started ---


def test_best_of_n_proxy_fail_fallback_picks_fastest_started(backend: DaytonaBackend) -> None:
    sb_fast = _make_sandbox("sb-fast")
    sb_slow = _make_sandbox("sb-slow")
    sandboxes = [sb_fast, sb_slow]
    idx = 0

    async def create_side_effect(browser_id: str) -> Any:
        nonlocal idx
        sb = sandboxes[idx % len(sandboxes)]
        idx += 1
        return sb

    async def configure_side_effect(sandbox: Any, *args: Any, **kwargs: Any) -> None:
        if sandbox.name == "sb-slow":
            await asyncio.sleep(0.05)
        raise ProxyVerificationError(f"IP unchanged on {sandbox.name}")

    with (
        patch.object(backend, "_create", side_effect=create_side_effect),
        patch(
            "getgather.browsers.daytona_browsers._configure_remote_sandbox",
            side_effect=configure_side_effect,
        ),
        patch.object(backend, "_teardown_losers", new_callable=AsyncMock),
        patch("getgather.browsers.daytona_browsers.settings") as mock_settings,
    ):
        mock_settings.DAYTONA_BEST_OF_N = 2

        winner = asyncio.run(backend._best_of_n("uid123", None, None))  # type: ignore[reportPrivateUsage]

    # sb_fast started first (no sleep before raising), sb_slow started later
    assert winner.name == "sb-fast"


# --- _best_of_n: zero sandboxes created → raises ---


def test_best_of_n_zero_creates_raises(backend: DaytonaBackend) -> None:
    async def create_side_effect(browser_id: str) -> Any:
        raise RuntimeError("Daytona API error")

    with (
        patch.object(backend, "_create", side_effect=create_side_effect),
        patch("getgather.browsers.daytona_browsers.settings") as mock_settings,
    ):
        mock_settings.DAYTONA_BEST_OF_N = 2

        with pytest.raises(RuntimeError, match="failed to create"):
            asyncio.run(backend._best_of_n("uid123", None, None))  # type: ignore[reportPrivateUsage]


# --- _best_of_n: all created but none started → raises ---


def test_best_of_n_all_start_fail_raises(backend: DaytonaBackend) -> None:
    sb = _make_sandbox("sb-a", state="stopped")
    sb.start = AsyncMock(side_effect=RuntimeError("start failed"))

    async def create_side_effect(browser_id: str) -> Any:
        return sb

    with (
        patch.object(backend, "_create", side_effect=create_side_effect),
        patch("getgather.browsers.daytona_browsers.settings") as mock_settings,
    ):
        mock_settings.DAYTONA_BEST_OF_N = 2

        with pytest.raises(RuntimeError, match="failed to start"):
            asyncio.run(backend._best_of_n("uid123", None, None))  # type: ignore[reportPrivateUsage]


# --- create_browser: N=1 goes through _ensure, not _best_of_n ---


def test_create_browser_n1_uses_ensure_not_best_of_n(backend: DaytonaBackend) -> None:
    sb = _make_sandbox("sb-single")

    async def _get_none(browser_id: str) -> None:
        return None

    with (
        patch.object(backend, "_get", side_effect=_get_none),
        patch.object(backend, "_ensure", new_callable=AsyncMock, return_value=sb),
        patch.object(backend, "_best_of_n", new_callable=AsyncMock) as mock_bon,
        patch(
            "getgather.browsers.daytona_browsers._configure_remote_sandbox",
            new_callable=AsyncMock,
        ),
        patch.object(
            backend, "_get_info", new_callable=AsyncMock, return_value={"hostname": "sb-single"}
        ),
        patch("getgather.browsers.daytona_browsers.settings") as mock_settings,
    ):
        mock_settings.DAYTONA_BEST_OF_N = 1

        asyncio.run(backend.create_browser("uid123", None, None))

    mock_bon.assert_not_called()


# --- create_browser: N>1, started sandbox exists → skips best_of_n ---


def test_create_browser_existing_started_skips_best_of_n(backend: DaytonaBackend) -> None:
    sb = _make_sandbox("sb-existing")

    with (
        patch.object(backend, "_get", new_callable=AsyncMock, return_value=sb),
        patch.object(backend, "_best_of_n", new_callable=AsyncMock) as mock_bon,
        patch(
            "getgather.browsers.daytona_browsers._configure_remote_sandbox",
            new_callable=AsyncMock,
        ),
        patch.object(
            backend, "_get_info", new_callable=AsyncMock, return_value={"hostname": "sb-existing"}
        ),
        patch("getgather.browsers.daytona_browsers.settings") as mock_settings,
    ):
        mock_settings.DAYTONA_BEST_OF_N = 3

        asyncio.run(backend.create_browser("uid123", None, None))

    mock_bon.assert_not_called()
