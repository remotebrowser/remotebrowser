import re
import socket

from loguru import logger
from pydantic import BaseModel, model_validator

MAX_USER_ID_LENGTH = 54
NO_AUTH_PROVIDER = "noauth"


class AuthUser(BaseModel):
    sub: str
    auth_provider: str = NO_AUTH_PROVIDER

    @model_validator(mode="after")
    def validate_user_id(self) -> "AuthUser":
        if len(self.user_id) > MAX_USER_ID_LENGTH:
            raise ValueError(f"User id is too long: {self.user_id}")
        if not re.match(r"^[a-z0-9-]+$", self.user_id):
            raise ValueError(f"User id contains invalid characters: {self.user_id}")
        return self

    @property
    def user_id(self) -> str:
        """
        Unique user name combining login and auth provider.
        Only numbers, lowercase letters and dashes are allowed.
        Maximum length is 54 characters.
        """
        return f"{self.sub}-{self.auth_provider}"

    def dump(self):
        return self.model_dump(exclude_none=True, mode="json")


def get_auth_user() -> AuthUser:
    """Fake auth user, kept so callers can key browsers by a stable per-host id."""
    hostname = socket.gethostname()
    logger.warning(f"Hostname is {hostname}")
    sub = re.sub(r"[^a-z0-9-]", "", hostname.lower().removesuffix(".local"))
    return AuthUser(sub=sub)
