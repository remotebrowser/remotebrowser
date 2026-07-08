import re
import socket

from loguru import logger


def get_host_id() -> str:
    """Stable per-host id, used as the fallback browser key when no mcp-session-id is present."""
    hostname = socket.gethostname()
    logger.warning(f"Hostname is {hostname}")
    return re.sub(r"[^a-z0-9-]", "", hostname.lower().removesuffix(".local")) + "-noauth"
