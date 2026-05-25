from typing import Any, cast
import zendriver as zd
from loguru import logger

from getgather.browser import retry_with_navigation, zen_navigate_with_retry
from getgather.mcp.dpage import (
    remote_zen_dpage_with_action,
)
from getgather.mcp.registry import MCPTool

safeway_mcp = MCPTool.registry["safeway"]


async def get_orders_from_api(tab: zd.Tab, page_number: int = 1) -> dict[str, Any]:
    """Get the orders from the Safeway API with retry logic"""
    logger.info(f"Starting get_orders_from_api (page_number={page_number})")

    async def fetch_orders() -> dict[str, Any]:
        orders = None

        await zen_navigate_with_retry(
            tab, "https://www.safeway.com/order-account/orders", wait_for_ready=False
        )
        orders = await tab.evaluate(
            f"""
                (async () => {{
                    const httpRequest = await new Promise(resolve => {{
                        const originalOpen = XMLHttpRequest.prototype.open;
                        const originalSend = XMLHttpRequest.prototype.send;
                        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

                        XMLHttpRequest.prototype.open = function(method, url, ...rest) {{
                            this._interceptMethod = method;
                            this._interceptUrl = url;
                            this._interceptHeaders = {{}};
                            return originalOpen.call(this, method, url, ...rest);
                        }};

                        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {{
                            if (!this._interceptHeaders) this._interceptHeaders = {{}};
                            this._interceptHeaders[name] = value;
                            return originalSetRequestHeader.call(this, name, value);
                        }};

                        XMLHttpRequest.prototype.send = function(body) {{
                            const url = String(this._interceptUrl || '');
                            const method = String(this._interceptMethod || '').toUpperCase();
                            if (url.includes('/order-account/api/order') && method === 'POST') {{
                                XMLHttpRequest.prototype.open = originalOpen;
                                XMLHttpRequest.prototype.send = originalSend;
                                XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
                                resolve([url, {{ method, body, headers: this._interceptHeaders }}]);
                            }}
                            return originalSend.call(this, body);
                        }};
                    }})

                    const url = httpRequest[0]
                    const headers = httpRequest[1].headers
                    const originalBody = JSON.parse(httpRequest[1].body);
                    const body = {{
                        ...originalBody,
                    }};
                    
                    const res = await fetch(url, {{
                        method: 'POST',
                        credentials: 'include',
                        headers,
                        body: JSON.stringify(body)
                    }});
                    if (!res.ok) {{
                        const error_text = await res.text();
                        throw new Error(`HTTP error! status: ${{res.status}} - ${{error_text}}`);
                    }}
                    const ordersData = await res.json();
                    const orders = ordersData.orders || [];
                    const orderResults = [];
                    await Promise.all(orders.map(async (order) => {{
                        if (!order.orderNumber) return;
                        try {{
                            const detailRes = await fetch(
                                `https://www.safeway.com/order-account/api/order/${{order.orderNumber}}`,
                                {{
                                    method: 'GET',
                                    credentials: 'include',
                                    headers
                                }}
                            );
                            if (!detailRes.ok) {{
                                const error_text = await detailRes.text();
                                console.warn(
                                    `Order detail fetch failed for ${{order.orderNumber}}: `
                                    + `${{detailRes.status}} - ${{error_text}}`
                                );
                                return;
                            }}
                            orderResults.push(await detailRes.json());
                        }} catch (e) {{
                            console.warn(
                                `Order detail fetch failed for ${{order.orderNumber}}: ${{e}}`
                            );
                        }}
                    }}));
                    return orderResults;

                }})()
            """,
            True,
        )
        return cast(dict[str, Any], orders)

    return await retry_with_navigation(
        tab=tab,
        operation=fetch_orders,
        max_retries=3,
        exceptions=(Exception,),
        re_raise_on_max_retries=True,
        timeout_seconds=30,
        operation_name=f"get_orders_from_api (page_number={page_number})",
    )


# TODO: pagination still not implemented, need test account
@safeway_mcp.tool
async def get_purchases(page_number: int = 1) -> dict[str, Any]:
    """Get the purchase history from a user's Safeway account via API."""

    async def get_order_details_action(tab: zd.Tab, _) -> dict[str, Any]:
        """Get the details of an order from Safeway"""
        logger.info("🔧 Executing get_orders_from_api...")
        result: dict[str, Any] = await get_orders_from_api(tab, page_number)
        return {"safeway_orders": result}

    return await remote_zen_dpage_with_action(
        "https://www.safeway.com/order-account/orders",
        action=get_order_details_action,
    )
