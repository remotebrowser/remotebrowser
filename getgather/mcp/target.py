import asyncio
import html
import json
from typing import Any, cast

import zendriver as zd
from fastmcp.server.dependencies import get_http_headers
from loguru import logger

from getgather.browser import zen_navigate_with_retry
from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool
from getgather.zen_actions import parse_response_json

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


def _curate_order(raw: dict[str, Any]) -> dict[str, Any]:
    packages: list[dict[str, Any]] = []
    for pkg in raw.get("packages", []):
        gm = pkg.get("grouping_metadata", {})
        fulfillment = pkg.get("fulfillment", {})

        items: list[dict[str, Any]] = []
        for line in pkg.get("order_lines", []):
            item = line.get("item", {})
            curated_item: dict[str, Any] = {
                "description": html.unescape(item.get("description", "")),
                "quantity": line.get("quantity", 1),
                "unit_price": item.get("unit_price"),
                "tcin": item.get("tcin"),
                "seller": item.get("seller_details", {}).get("name"),
                "product_type": item.get("product_classification", {}).get("product_type_name"),
            }
            variations = item.get("variation_themes")
            if variations:
                curated_item["variations"] = {v["name"]: v["value"] for v in variations}
            return_orders = line.get("return_orders")
            if return_orders:
                curated_item["returns"] = [
                    {
                        "order_number": r.get("order_number"),
                        "placed_date": r.get("placed_date"),
                        "status": r.get("status_key"),
                        "reason": r.get("return_reason"),
                    }
                    for r in return_orders
                ]
            items.append(curated_item)

        curated_pkg: dict[str, Any] = {
            "fulfillment_type": gm.get("fulfillment_type"),
            "fulfillment_method": gm.get("fulfillment_method"),
            "status": gm.get("status"),
            "status_date": gm.get("status_date"),
            "items": items,
        }
        fulfilled_date = fulfillment.get("status", {}).get("date")
        if fulfilled_date:
            curated_pkg["fulfilled_date"] = fulfilled_date
        packages.append(curated_pkg)

    store_address: dict[str, Any] | None = None
    for addr in raw.get("addresses", []):
        if "STORE" in addr.get("types", []):
            store_address = {
                "name": addr.get("first_name"),
                "address": addr.get("address_line1"),
                "city": addr.get("city"),
                "state": addr.get("state"),
            }
            break

    summary = raw.get("summary", {})
    payments = [
        {"payment_type": p.get("guest_display_payment_type"), "amount": p.get("amount")}
        for p in raw.get("payments", [])
    ]

    result: dict[str, Any] = {
        "order_number": raw.get("order_number"),
        "order_date": raw.get("order_date"),
        "order_type": raw.get("order_type"),
        "summary": {
            "grand_total": summary.get("grand_total"),
            "total_product_price": summary.get("total_product_price"),
            "total_taxes": summary.get("total_taxes"),
            "total_shipping_charges": summary.get("total_shipping_charges"),
            "total_items": summary.get("total_items"),
        },
        "payments": payments,
        "packages": packages,
    }
    if store_address:
        result["store_address"] = store_address
    return result


@target_mcp.tool
async def get_purchases() -> dict[str, Any]:
    """Get online purchase history from a user's Target account."""

    x_api_key = get_http_headers(include_all=True).get("x-api-key", "")

    async def action(page: zd.Tab, browser: zd.Browser) -> dict[str, Any]:
        logger.info("Target: signed in, fetching online purchase history")

        order_numbers: list[str] = []

        async with page.expect_response(".*/guest_order_aggregations/v1/order_history.*") as resp:
            await zen_navigate_with_retry(page, f"{BASE_URL}/orders", wait_for_ready=False)
            page1: dict[str, Any] = await parse_response_json(resp, {}, "target order list page 1")

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

        return {"target_purchases": [_curate_order(d) for d in details]}

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
