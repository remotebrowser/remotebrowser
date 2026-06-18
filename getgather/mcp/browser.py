import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import TypedDict, cast

import zendriver as zd
from loguru import logger
from websockets.exceptions import ConnectionClosed

from getgather.config import settings


def remove_profile_dir(user_data_dir: Path) -> None:
    """Remove a browser profile directory from disk."""
    if not user_data_dir.exists():
        return
    try:
        shutil.rmtree(user_data_dir)
    except Exception as e:
        logger.warning(f"Failed to remove profile dir {user_data_dir}: {e}")


async def terminate_zendriver_browser(browser: zd.Browser):
    browser_id = cast(str, browser.id)  # type: ignore[attr-defined]
    try:
        await browser.stop()
    except ConnectionClosed as e:
        logger.info(
            f"Browser websocket was already closed during shutdown for {browser_id}: {e}",
            extra={"profile_id": browser_id},
        )
    user_data_dir = settings.profiles_dir / browser_id
    logger.info(
        f"Terminating Zendriver browser and removing user_data_dir: {user_data_dir}",
        extra={"profile_id": browser_id},
    )
    # Profiles are never reopened after their browser is terminated
    # (init_zendriver_browser only looks up in-memory browsers), so remove
    # the whole profile dir instead of letting it accumulate on disk.
    remove_profile_dir(user_data_dir)


class BrowserInformation(TypedDict):
    last_active_timestamp: datetime


class BrowserManager:
    """Manages browser instances."""

    def __init__(self):
        self._incognito_browsers: dict[str, zd.Browser] = {}
        self._zen_global_browser: zd.Browser | None = None
        self._browser_information: dict[str, BrowserInformation] = {}

    def get_incognito_browser(self, id: str) -> zd.Browser | None:
        """Get an incognito browser by ID."""
        self.update_last_active(id)
        return self._incognito_browsers.get(id)

    def set_incognito_browser(self, id: str, browser: zd.Browser) -> None:
        """Set an incognito browser by ID."""
        self.update_last_active(id)
        self._incognito_browsers[id] = browser

    def has_incognito_browser(self, id: str) -> bool:
        """Check if an incognito browser exists by ID."""
        return id in self._incognito_browsers

    def get_global_browser(self) -> zd.Browser | None:
        """Get the global browser instance."""
        return self._zen_global_browser

    def set_global_browser(self, browser: zd.Browser) -> None:
        """Set the global browser instance."""
        self._zen_global_browser = browser

    def update_last_active(self, id: str):
        """Update the last active timestamp for this session."""
        if id not in self._browser_information:
            self._browser_information[id] = {"last_active_timestamp": datetime.now()}
        self._browser_information[id]["last_active_timestamp"] = datetime.now()

    def remove_incognito_browser(self, id: str):
        """Remove a browser by ID."""
        if id in self._incognito_browsers:
            self._incognito_browsers.pop(id)
        if id in self._browser_information:
            self._browser_information.pop(id)

    async def cleanup_incognito_browsers(self):
        """Cleanup incognito browsers that have not been used in the last 1 hour."""
        current_time = datetime.now()
        max_session_age = timedelta(minutes=settings.BROWSER_SESSION_AGE)
        signin_ids = list(self._incognito_browsers.keys())

        logger.info(f"Checking for old browsers to stop. Found {len(signin_ids)} browsers")

        # Find sessions that are older than max_session_age
        for signin_id in signin_ids:
            browser_information = self._browser_information.get(signin_id)
            if browser_information is None:
                logger.warning(
                    f"Signin ID {signin_id} has no browser information, skipping cleanup check"
                )
                continue

            last_active_timestamp = browser_information.get("last_active_timestamp")
            session_age = current_time - last_active_timestamp
            if session_age > max_session_age:
                try:
                    logger.info(
                        f"Signin ID {signin_id} has been inactive for more than {settings.BROWSER_SESSION_AGE} minutes, stopping it"
                    )
                    browser = self._incognito_browsers.get(signin_id)
                    if browser is None:
                        logger.warning(f"Signin ID {signin_id} not found, skipping termination")
                        continue
                    await terminate_zendriver_browser(browser)
                    logger.info(f"Successfully stopped browser with signin ID {signin_id}")
                except Exception as e:
                    logger.info(f"Failed to stop browser with signin ID {signin_id}: {e}")
                finally:
                    self.remove_incognito_browser(signin_id)

    def cleanup_orphaned_profiles(self):
        """Remove on-disk profile dirs that no longer belong to an active browser.

        Browser tracking is in-memory only, so profile dirs left behind by
        crashes, restarts or failed browser starts are never seen by
        cleanup_incognito_browsers and accumulate until the disk is full.
        Sweep the profiles dir and remove anything that is not an active
        browser and has not been modified within BROWSER_SESSION_AGE.
        """
        current_time = datetime.now()
        max_session_age = timedelta(minutes=settings.BROWSER_SESSION_AGE)

        active_ids = set(self._incognito_browsers.keys())
        if self._zen_global_browser is not None:
            global_browser_id = getattr(self._zen_global_browser, "id", None)
            if global_browser_id is not None:
                active_ids.add(cast(str, global_browser_id))

        removed_count = 0
        for profile_dir in settings.profiles_dir.iterdir():
            if not profile_dir.is_dir() or profile_dir.name in active_ids:
                continue
            try:
                last_modified = datetime.fromtimestamp(profile_dir.stat().st_mtime)
            except OSError as e:
                logger.warning(f"Failed to stat profile dir {profile_dir}: {e}")
                continue
            # Keep recently-modified dirs: they may belong to a browser that
            # is still starting up and not yet registered in the manager.
            if current_time - last_modified <= max_session_age:
                continue
            logger.info(
                f"Removing orphaned profile dir {profile_dir}",
                extra={"profile_id": profile_dir.name},
            )
            remove_profile_dir(profile_dir)
            removed_count += 1

        if removed_count:
            logger.info(f"Removed {removed_count} orphaned browser profile dirs")


browser_manager = BrowserManager()
