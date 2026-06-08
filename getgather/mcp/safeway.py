from typing import Any, cast

import zendriver as zd
from loguru import logger

from getgather.browser import retry_with_navigation, zen_navigate_with_retry
from getgather.mcp.dpage import (
    remote_zen_dpage_with_action,
)
from getgather.mcp.registry import MCPTool

safeway_mcp = MCPTool.registry["safeway"]

_INSTORE_INTERCEPT_SCRIPT = r"""
(() => {
  if (window.__ggSafewayInstoreHook) return;
  window.__ggSafewayInstoreHook = true;
  window.__ggSafewayInstoreCapture = null;

  const tryCapture = (url, method, body, headers) => {
    if (!url.includes("/order-account/api/instore") || method !== "POST") return;
    try {
      const rawBody = typeof body === "string" ? body : JSON.stringify(body);
      const parsed = JSON.parse(rawBody);
      if (parsed?.params?.id) return;
      window.__ggSafewayInstoreCapture = { url, body: rawBody, headers };
    } catch (_e) {}
  };

  const headersFromInit = (init) => {
    if (!init?.headers) return {};
    if (init.headers instanceof Headers) {
      return Object.fromEntries(init.headers.entries());
    }
    return { ...init.headers };
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ggInterceptMethod = method;
    this._ggInterceptUrl = url;
    this._ggInterceptHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this._ggInterceptHeaders) this._ggInterceptHeaders = {};
    this._ggInterceptHeaders[name] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    tryCapture(
      String(this._ggInterceptUrl || ""),
      String(this._ggInterceptMethod || "").toUpperCase(),
      body,
      this._ggInterceptHeaders
    );
    return originalSend.call(this, body);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = String(typeof args[0] === "string" ? args[0] : args[0]?.url || "");
    const init = args[1] || {};
    tryCapture(url, String(init.method || "GET").toUpperCase(), init.body, headersFromInit(init));
    return originalFetch.apply(this, args);
  };
})();
"""


async def _install_instore_intercept(tab: zd.Tab) -> None:
    """Install XHR/fetch hooks before navigation so early page loads are captured."""
    await tab.send(zd.cdp.page.enable())
    await tab.send(
        zd.cdp.page.add_script_to_evaluate_on_new_document(
            source=_INSTORE_INTERCEPT_SCRIPT,
            run_immediately=True,
        )
    )


_SAFEWAY_CONSOLE_LOG_TABS: set[str] = set()
_GG_SAFEWAY_EVAL_LOG_KEY = "__ggSafewayEvalLogs"
_GG_SAFEWAY_LOG_PREFIX = "[gg-safeway]"


def _format_console_arg(arg: zd.cdp.runtime.RemoteObject) -> str:
    if arg.value is not None:
        return str(arg.value)
    if arg.description:
        return arg.description
    return arg.type_


async def _enable_safeway_console_logging(tab: zd.Tab) -> None:
    """Forward browser console output to Python logs (Safeway only)."""
    tab_id = str(tab.target_id)
    if tab_id in _SAFEWAY_CONSOLE_LOG_TABS:
        return

    async def on_console(event: zd.cdp.runtime.ConsoleAPICalled) -> None:
        message = " ".join(_format_console_arg(arg) for arg in event.args)
        # Page noise (analytics, adobe target, etc.) drowns out evaluate logs; only
        # forward our prefixed messages. Evaluate console.log is also unreliable via
        # CDP — use _flush_safeway_eval_logs for in-page script output.
        if _GG_SAFEWAY_LOG_PREFIX not in message:
            return
        prefix = f"[safeway browser {tab_id}]"
        if event.type_ == "error":
            logger.error(f"{prefix} {message}")
        elif event.type_ == "warning":
            logger.warning(f"{prefix} {message}")
        elif event.type_ in ("debug", "verbose"):
            logger.debug(f"{prefix} {message}")
        else:
            logger.info(f"{prefix} {message}")

    await tab.send(zd.cdp.runtime.enable())
    tab.add_handler(zd.cdp.runtime.ConsoleAPICalled, on_console)  # type: ignore[reportUnknownMemberType]
    _SAFEWAY_CONSOLE_LOG_TABS.add(tab_id)
    logger.debug(f"Safeway browser console logging enabled for tab {tab_id}")


async def _reset_safeway_eval_logs(tab: zd.Tab) -> None:
    await tab.evaluate(f"window.{_GG_SAFEWAY_EVAL_LOG_KEY} = []", False)


async def _flush_safeway_eval_logs(tab: zd.Tab) -> None:
    """Log messages written by in-page __ggLog — reliable for tab.evaluate scripts."""
    raw = await tab.evaluate(f"window.{_GG_SAFEWAY_EVAL_LOG_KEY} || []", False)
    if not isinstance(raw, list):
        return
    entries = cast(list[Any], raw)
    for entry in entries:
        text = str(entry)
        if text.startswith("WARN: "):
            logger.warning(f"[safeway eval] {text[6:]}")
        else:
            logger.info(f"[safeway eval] {text}")


async def get_orders_from_api(tab: zd.Tab, page_number: int = 1) -> dict[str, Any]:
    """Get the orders from the Safeway API with retry logic"""
    logger.info(f"Starting get_orders_from_api (page_number={page_number})")
    await _enable_safeway_console_logging(tab)

    orders_url = "https://www.safeway.com/order-account/orders"

    async def fetch_orders() -> dict[str, Any]:
        logger.info(f"Navigating to {orders_url}")
        await zen_navigate_with_retry(tab, orders_url, wait_for_ready=False)
        logger.info("Navigation complete, intercepting online orders XHR")
        try:
            orders = await tab.evaluate(
                f"""
                (async () => {{
                    const httpRequest = await new Promise((resolve, reject) => {{
                        const INTERCEPT_TIMEOUT_MS = 25000;
                        const timeoutId = setTimeout(() => {{
                            reject(new Error(
                                `Online orders XHR intercept timed out after ${{INTERCEPT_TIMEOUT_MS}}ms: `
                                + `url=${{location.href}}`
                            ));
                        }}, INTERCEPT_TIMEOUT_MS);

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
                                clearTimeout(timeoutId);
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
        except Exception as e:
            logger.error(f"Online orders in-page script failed: {type(e).__name__}: {e}")
            raise
        if isinstance(orders, list):
            order_list = cast(list[Any], orders)
            logger.info(f"Online orders script complete, got {len(order_list)} orders")
        else:
            logger.warning(
                f"Online orders script returned unexpected type: {type(orders).__name__}"
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
async def get_purchases_online(page_number: int = 1) -> dict[str, Any]:
    """Get the purchase history from a user's Safeway account via API."""

    async def get_order_details_action(tab: zd.Tab, _) -> dict[str, Any]:
        """Get the details of an order from Safeway"""
        logger.info("🔧 Executing get_orders_from_api...")
        result: dict[str, Any] = await get_orders_from_api(tab, page_number)
        return {"safeway_online_purchases": result}

    return await remote_zen_dpage_with_action(
        "https://www.safeway.com/order-account/orders",
        action=get_order_details_action,
    )


async def get_in_store_purchases_from_api(tab: zd.Tab, page_number: int = 1) -> dict[str, Any]:
    """Get the orders from the Safeway API with retry logic"""
    logger.info(f"Starting get_in_store_purchases_from_api (page_number={page_number})")
    await _enable_safeway_console_logging(tab)
    orders_url = "https://www.safeway.com/order-account/orders"

    async def fetch_orders() -> dict[str, Any]:
        await _install_instore_intercept(tab)
        logger.info("Installed in-store intercept hook, resetting capture")
        await tab.evaluate("window.__ggSafewayInstoreCapture = null", False)
        logger.info(f"Navigating to {orders_url}")
        await zen_navigate_with_retry(tab, orders_url, wait_for_ready=False)
        logger.info("Navigation complete, waiting for in-store list API capture")
        await _reset_safeway_eval_logs(tab)
        try:
            orders = await tab.evaluate(
                """
                (async () => {
                    window.__ggSafewayEvalLogs = window.__ggSafewayEvalLogs || [];
                    const __ggLog = (msg) => {
                        window.__ggSafewayEvalLogs.push(msg);
                        console.log(`[gg-safeway] ${msg}`);
                    };
                    const __ggWarn = (msg) => {
                        window.__ggSafewayEvalLogs.push(`WARN: ${msg}`);
                        console.warn(`[gg-safeway] ${msg}`);
                    };

                    const clickTab = (label) => {
                        const items = document.querySelectorAll(
                            'ul > li[class*="tabs_myNavItem"]'
                        );
                        for (const li of items) {
                            if (li.textContent.includes(label)) {
                                li.click();
                                return true;
                            }
                        }
                        return false;
                    };

                    const triggerInstoreTab = () => {
                        clickTab('Online');
                        clickTab('In-store');
                    };

                    const waitForNavTabs = async (maxMs = 15000) => {
                        const start = Date.now();
                        while (Date.now() - start < maxMs) {
                            const items = document.querySelectorAll(
                                'ul > li[class*="tabs_myNavItem"]'
                            );
                            if (items.length > 0) return items.length;
                            await new Promise(r => setTimeout(r, 200));
                        }
                        return 0;
                    };

                    const captureToHttpRequest = () => {
                        const capture = window.__ggSafewayInstoreCapture;
                        if (!capture) return null;
                        return [capture.url, {
                            method: 'POST',
                            body: capture.body,
                            headers: capture.headers,
                        }];
                    };

                    const interceptError = (navTabCount, phase) => {
                        const items = document.querySelectorAll(
                            'ul > li[class*="tabs_myNavItem"]'
                        );
                        const tabLabels = Array.from(items).map(
                            li => (li.textContent || '').trim()
                        );
                        const inStoreTabFound = tabLabels.some(
                            label => label.includes('In-store')
                        );
                        return new Error(
                            `In-store API intercept timed out (${phase}): `
                            + `url=${location.href}, nav_tab_count=${navTabCount}, `
                            + `nav_tabs=${JSON.stringify(tabLabels)}, `
                            + `in_store_tab_found=${inStoreTabFound}, `
                            + `had_early_capture=${!!window.__ggSafewayInstoreCapture}`
                        );
                    };

                    const waitForCapture = async (navTabCount, phase) => {
                        const INTERCEPT_TIMEOUT_MS = 25000;
                        triggerInstoreTab();
                        const clickInterval = setInterval(triggerInstoreTab, 500);
                        try {
                            const start = Date.now();
                            while (Date.now() - start < INTERCEPT_TIMEOUT_MS) {
                                const httpRequest = captureToHttpRequest();
                                if (httpRequest) return httpRequest;
                                await new Promise(r => setTimeout(r, 200));
                            }
                            throw interceptError(navTabCount, phase);
                        } finally {
                            clearInterval(clickInterval);
                        }
                    };

                    const navTabCount = await waitForNavTabs();
                    __ggLog(`In-store: found ${navTabCount} nav tabs`);

                    let httpRequest = captureToHttpRequest();
                    if (httpRequest) {
                        __ggLog('In-store: using API capture from early page load');
                    } else {
                        try {
                            httpRequest = await waitForCapture(navTabCount, 'first attempt');
                            __ggLog('In-store: captured list API after tab switch');
                        } catch (firstError) {
                            __ggLog(`In-store: first attempt failed (${firstError}), reloading`);
                            window.__ggSafewayInstoreCapture = null;
                            location.reload();
                            const navTabCountAfterReload = await waitForNavTabs();
                            httpRequest = await waitForCapture(
                                navTabCountAfterReload,
                                'after reload'
                            );
                        }
                    }

                    const url = httpRequest[0]
                    const headers = httpRequest[1].headers
                    const originalBody = JSON.parse(httpRequest[1].body);
                    const body = {
                        ...originalBody,
                    };

                    const res = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers,
                        body: JSON.stringify(body)
                    });
                    if (!res.ok) {
                        if (res.status === 404) {
                            __ggLog('In-store: list API returned 404, treating as no receipts');
                            return [];
                        }
                        const error_text = await res.text();
                        throw new Error(`HTTP error! status: ${res.status} - ${error_text}`);
                    }
                    const ordersData = await res.json();
                    const orders = ordersData.receipts || [];
                    __ggLog(`In-store list fetch OK: ${orders.length} receipts`);
                    const orderResults = [];

                    await Promise.all(orders.map(async (order) => {
                        if (!order._id) return;
                        try {
                            const detailRes = await fetch(
                                `https://www.safeway.com/order-account/api/instore`,
                                {
                                    method: 'POST',
                                    credentials: 'include',
                                    headers,
                                    body: JSON.stringify({
                                        banner: "safeway",
                                        token: body.token,
                                        params: {
                                            clubcard: body.params.clubcard,
                                            id: order._id
                                        }
                                    })
                                }
                            );
                            if (!detailRes.ok) {
                                const error_text = await detailRes.text();
                                __ggWarn(
                                    `Order detail fetch failed for ${order.orderNumber}: `
                                    + `${detailRes.status} - ${error_text}`
                                );
                                return;
                            }
                            const detailData = await detailRes.json();
                            if (detailData.receipts[0]) {
                                orderResults.push({id: order._id, data: detailData.receipts[0]});
                            }
                        } catch (e) {
                            __ggWarn(`Order detail fetch failed for ${order.orderNumber}: ${e}`);
                        }
                    }));
                    __ggLog(
                        `In-store detail fetch complete: `
                        + `${orderResults.length}/${orders.length} receipts`
                    );
                    return orderResults;
                })()
            """,
                True,
            )
        except Exception as e:
            await _flush_safeway_eval_logs(tab)
            logger.error(f"In-store in-page script failed: {type(e).__name__}: {e}")
            raise
        await _flush_safeway_eval_logs(tab)
        if isinstance(orders, list):
            receipt_list = cast(list[Any], orders)
            logger.info(f"In-store orders script complete, got {len(receipt_list)} receipts")
        else:
            logger.warning(f"In-store script returned unexpected type: {type(orders).__name__}")
        return cast(dict[str, Any], orders)

    return await retry_with_navigation(
        tab=tab,
        operation=fetch_orders,
        max_retries=3,
        exceptions=(Exception,),
        re_raise_on_max_retries=True,
        timeout_seconds=120,
        operation_name=f"get_in_store_purchases_from_api (page_number={page_number})",
    )


@safeway_mcp.tool
async def get_purchases_in_store(page_number: int = 1) -> dict[str, Any]:
    """Get the purchase history from a user's Safeway account via API."""

    async def get_order_details_action(tab: zd.Tab, _) -> dict[str, Any]:
        """Get the details of an order from Safeway"""
        logger.info("🔧 Executing get_in_store_purchases_from_api...")
        result: dict[str, Any] = await get_in_store_purchases_from_api(tab, page_number)
        return {"safeway_in_store_purchases": result}

    return await remote_zen_dpage_with_action(
        "https://www.safeway.com/order-account/orders",
        action=get_order_details_action,
    )
