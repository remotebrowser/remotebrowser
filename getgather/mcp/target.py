import asyncio
import json
from typing import Any, cast

import zendriver as zd
from loguru import logger

from getgather.browser import zen_navigate_with_retry
from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool

target_mcp = MCPTool.registry["target"]

BASE_URL = "https://www.target.com"
API_BASE = "https://api.target.com"
LIST_PAGE_SIZE = 10

_LIST_URL = (
    f"{API_BASE}/guest_order_aggregations/v1/order_history"
    f"?page_size={LIST_PAGE_SIZE}&order_purchase_type=ONLINE"
    f"&pending_order=true&shipt_status=true"
)
_DETAIL_BASE = f"{API_BASE}/post_orders/v1"


async def _fetch_list_page(page: zd.Tab, page_number: int, x_api_key: str) -> dict[str, Any]:
    url = f"{_LIST_URL}&page_number={page_number}"
    js_code = f"""
        (async () => {{
            const res = await fetch('{url}', {{
                credentials: 'include',
                headers: {{
                    'accept': 'application/json',
                    'x-api-key': '{x_api_key}',
                }},
            }});
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        }})()
    """
    return cast(dict[str, Any], await page.evaluate(js_code, True))


async def _fetch_all_details(
    page: zd.Tab, order_numbers: list[str], x_api_key: str
) -> list[dict[str, Any]]:
    numbers_json = json.dumps(order_numbers)
    js_code = f"""
        (async () => {{
            const orderNumbers = {numbers_json};
            const results = await Promise.all(orderNumbers.map(n =>
                fetch('{_DETAIL_BASE}/' + n, {{
                    credentials: 'include',
                    headers: {{
                        'accept': 'application/json',
                        'x-api-key': '{x_api_key}',
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
async def get_purchases() -> dict[str, Any]:
    """Get online purchase history from a user's Target account."""

    async def action(page: zd.Tab, browser: zd.Browser) -> dict[str, Any]:
        logger.info("Target: signed in, fetching online purchase history")

        order_numbers: list[str] = []

        await zen_navigate_with_retry(page, f"{BASE_URL}/orders", wait_for_ready=False)
        intercept_result = cast(dict[str, Any], await page.evaluate(
            """
            (async () => {
                const httpRequest = await new Promise(resolve => {
                    const originalFetch = window.fetch;
                    window.fetch = async function (...args) {
                        if (typeof args[0] === 'string' && args[0].includes('/guest_order_aggregations/v1/order_history')) {
                            window.fetch = originalFetch;
                            resolve(args);
                        }
                        return originalFetch.apply(this, args);
                    };
                });
                const res = await fetch(httpRequest[0], {...httpRequest[1], credentials: 'include'});
                return {
                    page1: await res.json(),
                    x_api_key: (httpRequest[1].headers || {})['x-api-key'] ?? ''
                };
            })()
            """,
            True,
        ))

        page1 = cast(dict[str, Any], intercept_result.get("page1", {}))
        x_api_key = str(intercept_result.get("x_api_key", ""))

        orders_page1 = page1.get("orders", [])
        order_numbers.extend(o["order_number"] for o in orders_page1 if "order_number" in o)
        total_pages = int(page1.get("total_pages", 1))

        for page_num in range(2, total_pages + 1):
            try:
                page_data = await _fetch_list_page(page, page_num, x_api_key)
                order_numbers.extend(
                    o["order_number"] for o in page_data.get("orders", []) if "order_number" in o
                )
            except Exception as e:
                logger.warning(f"Target: failed to fetch list page {page_num}: {e}")

        if not order_numbers:
            return {"target_purchases": []}

        try:
            details = await asyncio.wait_for(
                _fetch_all_details(page, order_numbers, x_api_key), timeout=60.0
            )
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
