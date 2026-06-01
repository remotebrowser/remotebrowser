from typing import Any

import zendriver as zd

from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool

costco_mcp = MCPTool.registry["costco"]


@costco_mcp.tool
async def get_orders() -> dict[str, Any]:
    """Get order history from a user's Costco account."""

    async def _action(_page: zd.Tab, _browser: zd.Browser) -> dict[str, Any]:
        return {"costco_orders": []}

    return await remote_zen_dpage_with_action(
        "https://www.costco.com/my/AccountHomeView",
        action=_action,
    )
