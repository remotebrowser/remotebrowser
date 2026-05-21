from typing import Any, cast

import zendriver as zd

from getgather.mcp.dpage import remote_zen_dpage_with_action
from getgather.mcp.registry import MCPTool

walmart_mcp = MCPTool.registry["walmart"]


async def _get_order_history_action(tab: zd.Tab, _: zd.Browser, page_cursor: str) -> dict[str, Any]:
    result = await tab.evaluate(
        f"""
        (async () => {{
            const httpRequest = await new Promise((resolve, reject) => {{
                const timer = setTimeout(() => reject(new Error('Timed out waiting for PurchaseHistoryV3')), 10000);
                const originalFetch = window.fetch;
                window.fetch = async function (...args) {{
                    if (typeof args[0] === 'string' && args[0].includes('/PurchaseHistoryV3')) {{
                        window.fetch = originalFetch;
                        clearTimeout(timer);
                        resolve({{ url: args[0], headers: (args[1] || {{}}).headers || {{}} }});
                    }}
                    return originalFetch.apply(this, args);
                }};
                document.querySelector('button[name="viewPurchaseHistory"]')?.click();
            }});

            const baseUrl = httpRequest.url.split('?')[0];
            const headers = httpRequest.headers;

            const variables = encodeURIComponent(JSON.stringify({{
                input: {{
                    cursor: {repr(page_cursor)},
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


@walmart_mcp.tool
async def get_order_history(page_cursor: str = "") -> dict[str, Any]:
    """Get order history from a user's Walmart account. Pass next_cursor from a previous response to fetch the next page."""
    async def action(tab: zd.Tab, browser: zd.Browser) -> dict[str, Any]:
        return await _get_order_history_action(tab, browser, page_cursor)

    return await remote_zen_dpage_with_action(
        "https://www.walmart.com/account",
        action,
    )
