from typing import Any

import zendriver as zd
from loguru import logger

from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool

target_mcp = MCPTool.registry["target"]


@target_mcp.tool
async def get_purchases() -> dict[str, Any]:
    """Get purchase history from a user's Target account."""

    async def get_purchases_action(_page: zd.Tab, _browser: zd.Browser) -> dict[str, Any]:
        logger.info("✅ Target get_purchases: signed in, reached order history page")
        return {
            "target_purchases": [],
            "message": "Successfully signed in and reached order history page. Purchase history extraction not yet implemented.",
        }

    return await remote_zen_dpage_with_action(
        "https://www.target.com/orders",
        action=get_purchases_action,
    )
