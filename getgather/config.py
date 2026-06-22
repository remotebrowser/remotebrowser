from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from getgather.auth.settings import AuthSettings
from getgather.browsers.settings import BrowserSettings

FRIENDLY_CHARS = "23456789abcdefghijkmnpqrstuvwxyz"

PROJECT_DIR = Path(__file__).resolve().parent.parent


class Settings(AuthSettings, BrowserSettings, BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_DIR / ".env", env_ignore_empty=True, extra="ignore"
    )
    ENVIRONMENT: str = "local"
    GIT_REV: str = ""

    DATA_DIR: str = ""

    # Logging
    LOG_LEVEL: str = "INFO"
    SENTRY_DSN: str = ""
    LOGFIRE_TOKEN: str = ""

    @property
    def data_dir(self) -> Path:
        path = Path(self.DATA_DIR).resolve() if self.DATA_DIR else PROJECT_DIR / "data"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def screenshots_dir(self) -> Path:
        path = self.data_dir / "screenshots"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # Recording
    RECORDING_STORAGE: str = "local"  # "local" | "s3"
    RECORDING_DIR: str = ""
    TIGRIS_BUCKET: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_ENDPOINT_URL: str = ""

    @property
    def recordings_dir(self) -> Path:
        path = (
            Path(self.RECORDING_DIR).resolve()
            if self.RECORDING_DIR
            else self.data_dir / "recordings"
        )
        path.mkdir(parents=True, exist_ok=True)
        return path


settings = Settings()
