import asyncio
import json
import random
from typing import Any, cast

import zendriver as zd
from loguru import logger

from getgather.browser import (
    get_new_page,
    retry_with_navigation,
    safe_close_page,
    zen_navigate_with_retry,
)
from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool

walmart_mcp = MCPTool.registry["walmart"]

_BATCH_SIZE = 3


async def _get_order_history(tab: zd.Tab, page_cursor: str) -> dict[str, Any]:
    logger.info("Executing _get_order_history")

    async def fetch_orders() -> dict[str, Any]:
        result = await tab.evaluate(
            f"""
            (async () => {{
                const btn = await new Promise((resolve, reject) => {{
                    const deadline = Date.now() + 10000;
                    const poll = () => {{
                        const el = document.querySelector('button[name="viewPurchaseHistory"]');
                        if (el) return resolve(el);
                        if (Date.now() >= deadline) return reject(new Error('viewPurchaseHistory button not found'));
                        setTimeout(poll, 200);
                    }};
                    poll();
                }});

                const httpRequest = await new Promise((resolve, reject) => {{
                    const originalFetch = window.fetch;
                    const restore = () => {{ window.fetch = originalFetch; }};
                    const timer = setTimeout(() => {{
                        restore();
                        reject(new Error('Timed out waiting for PurchaseHistoryV3'));
                    }}, 10000);

                    window.fetch = async function (...args) {{
                        if (typeof args[0] === 'string' && args[0].includes('/PurchaseHistoryV3')) {{
                            restore();
                            clearTimeout(timer);
                            const rawHeaders = (args[1] || {{}}).headers || {{}};
                            const headers = rawHeaders instanceof Headers
                                ? Object.fromEntries(rawHeaders.entries())
                                : rawHeaders;
                            resolve({{ url: args[0], headers }});
                        }}
                        return originalFetch.apply(this, args);
                    }};

                    btn.click();
                }});

                const baseUrl = httpRequest.url.split('?')[0];
                const headers = httpRequest.headers;

                const variables = encodeURIComponent(JSON.stringify({{
                    input: {{
                        cursor: {json.dumps(page_cursor)},
                        search: '',
                        filterIds: [],
                        limit: 20,
                        type: null,
                        minTimestamp: null,
                        maxTimestamp: null,
                        filters: {{ minTimestamp: null, maxTimestamp: null, filterIds: [] }},
                        enabledFeatures: [],
                        eligibleFeatures: {{ isEbtEligible: false, enablePhFiltersEnhancement: true }}
                    }},
                    platform: 'WEB',
                    enableIsWcpOrder: false
                }}));

                const res = await fetch(`${{baseUrl}}?variables=${{variables}}`, {{
                    method: 'GET',
                    credentials: 'include',
                    headers
                }});
                if (!res.ok) {{
                    const text = await res.text();
                    throw new Error(`HTTP error! status: ${{res.status}} - ${{text}}`);
                }}
                const data = await res.json();
                const purchaseHistory = data?.data?.purchaseHistory;
                if (!purchaseHistory) throw new Error('purchaseHistory not found in response');
                return purchaseHistory;
            }})()
            """,
            await_promise=True,
        )
        return {"order_history": cast(dict[str, Any], result)}

    return await retry_with_navigation(
        tab=tab,
        operation=fetch_orders,
        navigation_url="https://www.walmart.com/account",
        max_retries=3,
        exceptions=(Exception,),
        re_raise_on_max_retries=True,
        operation_name="get_order_history",
    )


_COLLECT_ITEMS_JS = """
function collectItems(priceByItemId, items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        const id = item?.id;
        const pi = item?.priceInfo;
        if (!id || !pi) continue;
        priceByItemId[id] = {
            linePrice: pi.linePrice ?? null,
            itemPrice: pi.itemPrice ?? null,
            unitPrice: pi.unitPrice ?? null,
            canonicalUrl: item?.productInfo?.canonicalUrl ?? null
        };
    }
}
"""


async def _fetch_single_order_detail(
    browser: zd.Browser, order_id: str, group_id: str
) -> dict[str, Any] | None:
    """Open a new tab on the order detail page and extract price data from __NEXT_DATA__.

    Returns a map of itemId -> priceInfo, or None on failure.
    """
    detail_url = f"https://www.walmart.com/orders/{order_id}?groupId={group_id}"
    logger.info("Opening order detail tab for order {}: {}", order_id, detail_url)
    try:
        page = await get_new_page(browser)
    except Exception as e:
        logger.warning("Failed to open tab for order {}: {}", order_id, e)
        return None

    try:
        await zen_navigate_with_retry(page, detail_url)

        raw = await page.evaluate(
            f"""
            (async () => {{
                {_COLLECT_ITEMS_JS}

                const el = document.getElementById('__NEXT_DATA__');
                if (!el) return {{ _error: 'no __NEXT_DATA__ element found' }};
                if (!el.textContent) return {{ _error: '__NEXT_DATA__ element is empty' }};

                let parsed;
                try {{ parsed = JSON.parse(el.textContent); }} catch (e) {{
                    return {{ _error: `JSON parse failed: ${{e.message}}` }};
                }}

                const order = parsed?.props?.pageProps?.initialData?.data?.order;
                if (!order) {{
                    const keys = JSON.stringify(Object.keys(parsed?.props?.pageProps?.initialData?.data ?? {{}}));
                    return {{ _error: `no order in __NEXT_DATA__, keys: ${{keys}}` }};
                }}

                const priceByItemId = {{}};
                const tg = order.tippableGroup;
                if (tg) collectItems(priceByItemId, tg.items);
                const groups = order.groups_2101;
                if (Array.isArray(groups)) {{
                    for (const g of groups) {{
                        if (Array.isArray(g.categories)) {{
                            for (const cat of g.categories) collectItems(priceByItemId, cat.items);
                        }}
                        if (Array.isArray(g.subGroups)) {{
                            for (const sg of g.subGroups) {{
                                if (Array.isArray(sg.categories)) {{
                                    for (const cat of sg.categories) collectItems(priceByItemId, cat.items);
                                }}
                            }}
                        }}
                    }}
                }}
                return priceByItemId;
            }})()
            """,
            await_promise=True,
        )

        if not isinstance(raw, dict):
            logger.warning("Order detail for {} returned unexpected type {}", order_id, type(raw))
            return None

        if "_error" in raw:
            logger.warning("Order detail fetch failed for {}: {}", order_id, raw["_error"])
            return None

        logger.info("Order detail fetched successfully for order {}", order_id)
        return cast(dict[str, Any], raw)

    except Exception as e:
        logger.warning("Order detail tab failed for order {}: {}", order_id, e)
        return None
    finally:
        await safe_close_page(page)


async def _fetch_order_details(
    browser: zd.Browser, orders: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Fetch order details for all orders in batches, each batch running concurrently.

    Never raises — returns an empty dict on any failure so order history still succeeds.
    """
    order_inputs: list[dict[str, str]] = []
    for order in orders:
        order_id = order.get("id", "")
        if not order_id:
            continue
        groups: list[dict[str, Any]] = order.get("groups", [])
        first_group: dict[str, Any] = groups[0] if groups else {}
        group_id: str = first_group.get("groupId") or first_group.get("id") or ""
        order_inputs.append({"orderId": order_id, "groupId": group_id})

    if not order_inputs:
        return {}

    total_batches = (len(order_inputs) + _BATCH_SIZE - 1) // _BATCH_SIZE
    logger.info(
        "Fetching order details for {} orders ({} batches of {})",
        len(order_inputs),
        total_batches,
        _BATCH_SIZE,
    )

    price_map: dict[str, dict[str, Any]] = {}
    for i in range(0, len(order_inputs), _BATCH_SIZE):
        chunk = order_inputs[i : i + _BATCH_SIZE]
        batch_num = i // _BATCH_SIZE + 1
        chunk_ids = [o["orderId"] for o in chunk]
        logger.info("Order detail batch {}/{}: {}", batch_num, total_batches, chunk_ids)

        results = await asyncio.gather(
            *[_fetch_single_order_detail(browser, o["orderId"], o["groupId"]) for o in chunk],
            return_exceptions=True,
        )

        succeeded: list[str] = []
        failed: list[str] = []
        for o, result in zip(chunk, results):
            oid = o["orderId"]
            if isinstance(result, BaseException):
                logger.warning("Unexpected error fetching order detail for {}: {}", oid, result)
                failed.append(oid)
            elif result is not None:
                price_map[oid] = result
                succeeded.append(oid)
            else:
                failed.append(oid)
        logger.info(
            "Batch {}/{} complete — succeeded: {}, failed: {}",
            batch_num,
            total_batches,
            succeeded,
            failed,
        )

        if i + _BATCH_SIZE < len(order_inputs):
            await asyncio.sleep(random.uniform(0.2, 0.5))

    return price_map


def _merge_price_info(
    purchase_history: dict[str, Any], price_map: dict[str, dict[str, Any]]
) -> None:
    """Mutate purchase_history in-place, attaching priceInfo to each item.

    Items for orders with no detail result get priceInfo=None explicitly.
    """
    for order in purchase_history.get("orders", []):
        order_id = order.get("id", "")
        item_prices = price_map.get(order_id)
        for group in order.get("groups", []):
            for item in group.get("items", []):
                item_id = item.get("id")
                detail = item_prices.get(item_id) if (item_prices and item_id) else None
                if detail:
                    item["priceInfo"] = {
                        "linePrice": detail.get("linePrice"),
                        "itemPrice": detail.get("itemPrice"),
                        "unitPrice": detail.get("unitPrice"),
                    }
                    item["canonicalUrl"] = detail.get("canonicalUrl")
                else:
                    item["priceInfo"] = None
                    item["canonicalUrl"] = None


@walmart_mcp.tool
async def get_order_history(page_cursor: str = "") -> dict[str, Any]:
    """Get order history from a user's Walmart account. Pass next_cursor from a previous response to fetch the next page."""

    async def action(tab: zd.Tab, browser: zd.Browser) -> dict[str, Any]:
        result = await _get_order_history(tab, page_cursor)
        purchase_history = result["order_history"]
        orders = purchase_history.get("orders", [])

        price_map = await _fetch_order_details(browser, orders)
        logger.info("Order price enrichment complete for {} orders", len(orders))

        _merge_price_info(purchase_history, price_map)
        return result

    return await remote_zen_dpage_with_action(
        "https://www.walmart.com/account",
        action,
    )
