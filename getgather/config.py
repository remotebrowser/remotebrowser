from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from getgather.auth.settings import AuthSettings
from getgather.browser.proxy_types import ProxyConfig

FRIENDLY_CHARS = "23456789abcdefghijkmnpqrstuvwxyz"

PROJECT_DIR = Path(__file__).resolve().parent.parent


class Settings(AuthSettings, BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_DIR / ".env", env_ignore_empty=True, extra="ignore"
    )
    ENVIRONMENT: str = "local"
    GIT_REV: str = ""

    DATA_DIR: str = ""

    CHROMEFLEET_URL: str = ""
    CHROMEFLEET_PROXY_URL: str = ""

    # Logging
    LOG_LEVEL: str = "INFO"
    SENTRY_DSN: str = ""
    LOGFIRE_TOKEN: str = ""

    # Default Proxy Type (optional - e.g., "proxy-0", "proxy-1")
    # If not set, no proxy will be used unless specified via x-proxy-type header
    DEFAULT_PROXY_TYPE: str = ""

    # Max session age, in minutes
    BROWSER_SESSION_AGE: int = 60

    # Overall wall-clock deadline for a single MCP tool call, in seconds.
    # Guards against a stuck tool call (e.g. a hung page navigation) running
    # indefinitely and pinning its browser.
    MCP_TOOL_CALL_TIMEOUT: int = 600
    MCP_ACTION_TIMEOUT: int = 300

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

    @property
    def profiles_dir(self) -> Path:
        path = self.data_dir / "profiles"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def proxy_configs(self) -> dict[str, ProxyConfig]:
        """Load proxy configurations from YAML file or environment variable (cached).

        Returns:
            dict: Mapping of proxy identifiers (e.g., 'proxy-0') to ProxyConfig objects
        """
        from getgather.browser.proxy_loader import load_proxy_configs

        return load_proxy_configs()

    @field_validator("CHROMEFLEET_PROXY_URL")
    @classmethod
    def validate_proxy_url_format(cls, v: str) -> str:
        """Ensure proxy URL doesn't include http:// or https:// prefix."""
        if not v:  # Allow empty string
            return v

        if v.startswith(("http://", "https://")):
            raise ValueError(
                "CHROMEFLEET_PROXY_URL should not include http:// or https:// prefix. "
                f"Expected format: [username:password@]host:port, got: {v}"
            )

        return v


settings = Settings()
