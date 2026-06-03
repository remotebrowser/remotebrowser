import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
import zendriver as zd
from pytest import MonkeyPatch
from websockets.exceptions import ConnectionClosed

from getgather.config import settings
from getgather.mcp.browser import (
    BrowserManager,
    remove_profile_dir,
    terminate_zendriver_browser,
)


class StubBrowser:
    """Minimal stand-in for zd.Browser: terminate only uses .id and .stop()."""

    def __init__(self, id: str, stop_error: Exception | None = None):
        self.id = id
        self.stopped = False
        self._stop_error = stop_error

    async def stop(self):
        self.stopped = True
        if self._stop_error is not None:
            raise self._stop_error


@pytest.fixture
def profiles_dir(tmp_path: Path, monkeypatch: MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "DATA_DIR", str(tmp_path))
    return settings.profiles_dir


def make_profile(profiles_dir: Path, profile_id: str, age: timedelta | None = None) -> Path:
    profile = profiles_dir / profile_id
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Cookies").write_text("cookies")
    if age is not None:
        mtime = (datetime.now() - age).timestamp()
        os.utime(profile, (mtime, mtime))
    return profile


class TestRemoveProfileDir:
    def test_removes_directory(self, profiles_dir: Path):
        profile = make_profile(profiles_dir, "abc123")
        remove_profile_dir(profile)
        assert not profile.exists()

    def test_missing_directory_is_noop(self, profiles_dir: Path):
        remove_profile_dir(profiles_dir / "missing")


class TestTerminateZendriverBrowser:
    @pytest.mark.asyncio
    async def test_stops_browser_and_removes_profile_dir(self, profiles_dir: Path):
        profile = make_profile(profiles_dir, "abc123")
        browser = StubBrowser("abc123")

        await terminate_zendriver_browser(cast(zd.Browser, browser))

        assert browser.stopped
        assert not profile.exists()

    @pytest.mark.asyncio
    async def test_removes_profile_dir_when_websocket_already_closed(self, profiles_dir: Path):
        profile = make_profile(profiles_dir, "abc123")
        browser = StubBrowser("abc123", stop_error=ConnectionClosed(None, None))

        await terminate_zendriver_browser(cast(zd.Browser, browser))

        assert not profile.exists()


class TestCleanupOrphanedProfiles:
    def test_removes_stale_orphaned_profiles(self, profiles_dir: Path):
        stale = make_profile(profiles_dir, "stale1", age=timedelta(hours=2))

        BrowserManager().cleanup_orphaned_profiles()

        assert not stale.exists()

    def test_keeps_recently_modified_profiles(self, profiles_dir: Path):
        recent = make_profile(profiles_dir, "recent", age=timedelta(minutes=1))

        BrowserManager().cleanup_orphaned_profiles()

        assert recent.exists()

    def test_keeps_profiles_of_active_browsers(self, profiles_dir: Path):
        active = make_profile(profiles_dir, "active", age=timedelta(hours=2))
        manager = BrowserManager()
        manager.set_incognito_browser("active", cast(zd.Browser, StubBrowser("active")))

        manager.cleanup_orphaned_profiles()

        assert active.exists()

    def test_keeps_profile_of_global_browser(self, profiles_dir: Path):
        global_profile = make_profile(profiles_dir, "global", age=timedelta(hours=2))
        manager = BrowserManager()
        manager.set_global_browser(cast(zd.Browser, StubBrowser("global")))

        manager.cleanup_orphaned_profiles()

        assert global_profile.exists()

    def test_ignores_stray_files(self, profiles_dir: Path):
        stray = profiles_dir / "stray.txt"
        stray.write_text("not a profile")
        mtime = (datetime.now() - timedelta(hours=2)).timestamp()
        os.utime(stray, (mtime, mtime))

        BrowserManager().cleanup_orphaned_profiles()

        assert stray.exists()

    def test_respects_browser_session_age_setting(
        self, profiles_dir: Path, monkeypatch: MonkeyPatch
    ):
        monkeypatch.setattr(settings, "BROWSER_SESSION_AGE", 5)
        stale = make_profile(profiles_dir, "stale1", age=timedelta(minutes=10))
        fresh = make_profile(profiles_dir, "fresh1", age=timedelta(minutes=2))

        BrowserManager().cleanup_orphaned_profiles()

        assert not stale.exists()
        assert fresh.exists()
