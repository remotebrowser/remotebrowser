from pytest import MonkeyPatch

from getgather.browser import _setup_cdp_url  # pyright: ignore[reportPrivateUsage]
from getgather.browsers.backend import create_backend
from getgather.browsers.fleet_browsers import FleetBackend
from getgather.browsers.podman_browsers import PodmanBackend
from getgather.config import settings


def test_create_backend_selects_fleet_when_url_set(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "CHROMEFLEET_URL", "http://localhost:8300")
    assert isinstance(create_backend(), FleetBackend)


def test_create_backend_defaults_to_podman_without_url(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "CHROMEFLEET_URL", "")
    monkeypatch.setattr(settings, "BROWSER_BACKEND", "podman")
    assert isinstance(create_backend(), PodmanBackend)


def test_fleet_cdp_websocket_base_rewrites_scheme(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "CHROMEFLEET_URL", "http://localhost:8300/")
    assert FleetBackend().cdp_websocket_base() == "ws://localhost:8300"

    monkeypatch.setattr(settings, "CHROMEFLEET_URL", "https://fleet.example.com")
    assert FleetBackend().cdp_websocket_base() == "wss://fleet.example.com"


def test_fleet_relay_url_matches_internal_cdp_url(monkeypatch: MonkeyPatch) -> None:
    # The /cdp relay target the router builds (cdp_websocket_base + "/cdp/{id}") must match the
    # URL getgather's own zendriver client connects to, so external and internal CDP agree.
    monkeypatch.setattr(settings, "CHROMEFLEET_URL", "http://localhost:8300")
    base = FleetBackend().cdp_websocket_base()
    assert f"{base}/cdp/abc123" == _setup_cdp_url("abc123")


def test_local_backend_opts_out_of_relay() -> None:
    # None signals the router to use the per-browser /json/version flow instead of a relay.
    assert PodmanBackend().cdp_websocket_base() is None
