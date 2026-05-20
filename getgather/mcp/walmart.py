from typing import Any, cast

import zendriver as zd

from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool

walmart_mcp = MCPTool.registry["walmart"]


async def _get_order_history_action(tab: zd.Tab, _: zd.Browser) -> dict[str, Any]:
    result = await tab.evaluate(
        """
        (() => {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) throw new Error('__NEXT_DATA__ not found');
            const data = JSON.parse(el.textContent);
            const purchaseHistory = data?.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory;
            if (!purchaseHistory) throw new Error('purchaseHistory not found in __NEXT_DATA__');
            return purchaseHistory;
        })()
        """,
        await_promise=False,
    )
    return {"walmart_order_history": cast(dict[str, Any], result)}


@walmart_mcp.tool
async def get_order_history() -> dict[str, Any]:
    """Get order history from a user's Walmart account."""
    return await remote_zen_dpage_with_action(
        "https://www.walmart.com/orders",
        _get_order_history_action,
    )
