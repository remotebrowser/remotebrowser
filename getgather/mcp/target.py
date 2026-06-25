import asyncio
import json
from typing import Any, cast

import zendriver as zd
from loguru import logger

from getgather.browser import zen_navigate_with_retry
from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool
from getgather.zen_actions import parse_response_json

target_mcp = MCPTool.registry["target"]

BASE_URL = "https://www.target.com"
API_BASE = "https://api.target.com"
X_API_KEY = "ff457966e64d5e877fdbad070f276d18ecec4a01"
LIST_PAGE_SIZE = 10

_LIST_URL = (
    f"{API_BASE}/guest_order_aggregations/v1/order_history"
    f"?page_size={LIST_PAGE_SIZE}&order_purchase_type=ONLINE"
    f"&pending_order=true&shipt_status=true"
)
_DETAIL_BASE = f"{API_BASE}/post_orders/v1"


async def _fetch_list_page(page: zd.Tab, page_number: int) -> dict[str, Any]:
    url = f"{_LIST_URL}&page_number={page_number}"
    js_code = f"""
        (async () => {{
            const res = await fetch('{url}', {{
                credentials: 'include',
                headers: {{
                    'accept': 'application/json',
                    'x-api-key': '{X_API_KEY}',
                }},
            }});
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        }})()
    """
    return cast(dict[str, Any], await page.evaluate(js_code, True))


async def _fetch_all_details(page: zd.Tab, order_numbers: list[str]) -> list[dict[str, Any]]:
    numbers_json = json.dumps(order_numbers)
    js_code = f"""
        (async () => {{
            const orderNumbers = {numbers_json};
            const results = await Promise.all(orderNumbers.map(n =>
                fetch('{_DETAIL_BASE}/' + n, {{
                    credentials: 'include',
                    headers: {{
                        'accept': 'application/json',
                        'x-api-key': '{X_API_KEY}',
                    }},
                }})
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
            ));
            return results;
        }})()
    """
    raw = await page.evaluate(js_code, True)
    if not isinstance(raw, list):
        return []
    return [cast(dict[str, Any], item) for item in cast(list[Any], raw) if isinstance(item, dict)]


@target_mcp.tool
async def get_purchases_online() -> dict[str, Any]:
    """Get online purchase history from a user's Target account."""

    async def action(page: zd.Tab, browser: zd.Browser) -> dict[str, Any]:
        logger.info("Target: signed in, fetching online purchase history")

        order_numbers: list[str] = []

        async with page.expect_response("*/guest_order_aggregations/v1/order_history*") as resp:
            await zen_navigate_with_retry(page, f"{BASE_URL}/orders", wait_for_ready=False)
            page1: dict[str, Any] = await parse_response_json(resp, {}, "target order list page 1")

        orders_page1 = page1.get("orders", [])
        order_numbers.extend(o["order_number"] for o in orders_page1 if "order_number" in o)
        total_pages = int(page1.get("total_pages", 1))

        for page_num in range(2, total_pages + 1):
            try:
                page_data = await _fetch_list_page(page, page_num)
                order_numbers.extend(
                    o["order_number"] for o in page_data.get("orders", []) if "order_number" in o
                )
            except Exception as e:
                logger.warning(f"Target: failed to fetch list page {page_num}: {e}")

        if not order_numbers:
            return {"target_purchases": []}

        try:
            details = await asyncio.wait_for(_fetch_all_details(page, order_numbers), timeout=60.0)
        except asyncio.TimeoutError:
            logger.warning("Target: detail fetch timed out")
            details = []

        return {"target_purchases": details}

    return await remote_zen_dpage_with_action(
        f"{BASE_URL}/orders",
        action=action,
    )


@target_mcp.tool
async def get_purchases_in_store() -> dict[str, Any]:
    """Get in-store purchase history from a user's Target account."""
    raise NotImplementedError(
        "get_purchases_in_store: Target in-store purchase API endpoint not yet investigated."
    )
