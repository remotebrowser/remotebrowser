import asyncio
import json
import os
from typing import Any

import zendriver as zd
from loguru import logger

from getgather.browser import zen_navigate_with_retry
from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool
from getgather.zen_distill import load_distillation_patterns, run_distillation_loop

target_mcp = MCPTool.registry["target"]

BASE_URL = "https://www.target.com"

_EXTRACT_DETAIL_JS = """
(() => {
    const items = [];

    // Try known data-test selectors for order detail items
    const containers = document.querySelectorAll(
        '[data-test="order-details-item"], [data-test="order-item"], [data-test="product-item"]'
    );
    containers.forEach(el => {
        const img = el.querySelector('img');
        const priceEl = el.querySelector('[data-test="product-price"], [class*="price"]');
        const qtyEl = el.querySelector('[data-test="product-quantity"], [class*="quantity"]');
        const name = img?.getAttribute('alt') || '';
        if (name) {
            items.push({
                name,
                img: img?.getAttribute('src') || '',
                price: priceEl?.textContent?.trim() || '',
                qty: qtyEl?.textContent?.trim() || '',
            });
        }
    });

    // Fallback: collect all Target product images with alt text
    if (items.length === 0) {
        document.querySelectorAll('img[alt][src*="target.scene7.com"]').forEach(img => {
            const name = img.getAttribute('alt') || '';
            if (name) {
                items.push({
                    name,
                    img: img.getAttribute('src') || '',
                    price: '',
                    qty: '',
                });
            }
        });
    }

    return JSON.stringify(items);
})()
"""


async def _extract_order_detail(page: zd.Tab) -> dict[str, Any]:
    try:
        raw = await page.evaluate(_EXTRACT_DETAIL_JS, await_promise=False)
        if isinstance(raw, str):
            items: list[dict[str, Any]] = json.loads(raw)
            return {"items": items}
    except Exception as e:
        logger.warning(f"Target detail extraction failed: {e}")
    return {"items": []}


@target_mcp.tool
async def get_purchases() -> dict[str, Any]:
    """Get purchase history from a user's Target account."""

    async def get_purchases_action(page: zd.Tab, browser: zd.Browser) -> dict[str, Any]:
        logger.info("✅ Target: signed in, collecting order list")

        path = os.path.join(os.path.dirname(__file__), "patterns", "**/target-*.html")
        patterns = load_distillation_patterns(path)

        _, _, order_list = await run_distillation_loop(
            patterns=patterns,
            browser=browser,
            timeout=5,
            page=page,
        )

        if not order_list:
            return {"target_purchases": []}

        purchases: list[dict[str, Any]] = []

        for order in order_list:
            order_url = order.get("order_url")
            if not order_url:
                purchases.append(dict(order))
                continue

            detail_url = (
                f"{BASE_URL}{order_url}" if str(order_url).startswith("/") else str(order_url)
            )
            logger.info(f"Target: fetching order detail {detail_url}")

            await zen_navigate_with_retry(page, detail_url)
            await asyncio.sleep(1)

            detail = await _extract_order_detail(page)
            purchases.append({**order, **detail})

        return {"target_purchases": purchases}

    return await remote_zen_dpage_with_action(
        f"{BASE_URL}/orders",
        action=get_purchases_action,
        timeout=10,
    )
