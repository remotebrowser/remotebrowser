import asyncio
import ipaddress
import os
import urllib.parse
from typing import Any

import zendriver as zd
from bs4 import BeautifulSoup, Tag
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastmcp.server.dependencies import get_http_headers
from loguru import logger
from nanoid import generate

from getgather.auth.auth import get_auth_user
from getgather.browser.chromefleet import (
    create_remote_browser,
    get_remote_browser,
    terminate_remote_browser,
)
from getgather.config import settings
from getgather.mcp.browser import browser_manager, terminate_zendriver_browser
from getgather.mcp.html_renderer import DEFAULT_TITLE, render_form
from getgather.zen_distill import (
    ElementConfig,
    Match,
    Pattern,
    autoclick as zen_autoclick,
    capture_page_artifacts as zen_capture_page_artifacts,
    distill as zen_distill,
    get_error,
    get_new_page,
    get_selector,
    init_zendriver_browser,
    load_distillation_patterns,
    page_batch_actions,
    page_query_selector,
    run_distillation_loop as zen_run_distillation_loop,
    safe_close_page,
    terminate,
    wait_for_ready_state,
    zen_navigate_with_retry,
    zen_report_distill_error,
)

router = APIRouter(prefix="/dpage", tags=["dpage"])


active_pages: dict[str, zd.Tab] = {}
completed_signins: set[str] = set()

# Max seconds for the distillation polling loop in zen_post_dpage (per HTTP request).
DEFAULT_DPAGE_POST_POLL_TIMEOUT = 60

FRIENDLY_CHARS: str = "23456789abcdefghijkmnpqrstuvwxyz"


def is_remote_browser(dpage_id: str) -> bool:
    return "--" in dpage_id


def _find_tab(browser: zd.Browser, target_id: str) -> zd.Tab | None:
    """Find a browser tab by its target ID."""
    for tab in browser.tabs:
        if tab.target_id == target_id:
            return tab
    return None


def _signin_flow_response(dpage_id: str) -> dict[str, Any]:
    """Build the standard sign-in flow response dict."""
    base_url = get_base_url()
    url = f"{base_url}/dpage/{dpage_id}"
    return {
        "url": url,
        "message": f"Continue to sign in in your browser at {url}.",
        "signin_id": dpage_id,
        "system_message": (
            f"Try open the url {url} in a browser with a tool if available. "
            "Give the url to the user so the user can open it manually in their browser. "
            "Then call check_signin with the signin_id to see when sign-in finished (it does not return tool data). "
            "Call the same MCP tool again to get the result. "
            "For incognito or explicit session flows, send the x-signin-id header on the retry. "
        ),
    }


def _target_domain_from_initial_url(initial_url: str) -> str:
    hostname = urllib.parse.urlparse(initial_url).hostname
    return hostname or ""


async def _run_action_with_timeout(
    action: Any, page: zd.Tab, browser: zd.Browser
) -> dict[str, Any]:
    timeout = settings.MCP_ACTION_TIMEOUT
    try:
        async with asyncio.timeout(timeout):
            return await action(page, browser)
    except TimeoutError:
        raise TimeoutError(f"Action timed out after {timeout}s") from None


async def _try_action_with_probe(
    browser: zd.Browser,
    initial_url: str,
    action: Any,
    timeout: int,
) -> dict[str, Any] | None:
    """Probe whether browser is already signed in and run the action if so.

    Opens a new tab, navigates to initial_url, and runs a non-interactive
    distillation check. If the page looks signed-in (terminated), executes
    the action and returns the result. Otherwise returns None so the caller
    can fall through to an interactive sign-in flow.
    """
    page = await get_new_page(browser)
    try:
        await zen_navigate_with_retry(page, initial_url)
        terminated = await _probe_page(
            location=initial_url, page=page, browser=browser, timeout=timeout
        )
        if terminated:
            result = await _run_action_with_timeout(action, page, browser)
            await safe_close_page(page)
            return result
        await safe_close_page(page)
        return None
    except TimeoutError:
        await safe_close_page(page)
        raise
    except Exception as e:
        logger.info(f"Stateless probe failed for {initial_url}: {e}")
        await safe_close_page(page)
        return None


async def _probe_page(
    *,
    location: str | None = None,
    page: zd.Tab,
    browser: zd.Browser,
    timeout: int = 2,
    patterns: list[Pattern] | None = None,
) -> bool:
    if patterns is None:
        path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
        patterns = load_distillation_patterns(path)
    terminated, _, _ = await zen_run_distillation_loop(
        location=location,
        patterns=patterns,
        browser=browser,
        timeout=timeout,
        interactive=False,
        close_page=False,
        page=page,
        report_error=False,
    )
    return terminated


async def dpage_add(
    page: zd.Tab,
    location: str,
    profile_id: str | None = None,
    config: ElementConfig | None = None,
):
    id = generate(FRIENDLY_CHARS, 8)

    try:
        if not location.startswith("http"):
            location = f"https://{location}"
        await zen_navigate_with_retry(page, location)
    except Exception as error:
        hostname = urllib.parse.urlparse(location).hostname or "unknown"
        await zen_report_distill_error(
            error=error,
            page=page,
            profile_id=profile_id or "unknown",
            location=location,
            hostname=hostname,
            iteration=0,
        )
    active_pages[id] = page
    if config:
        page.element_config = config  # type: ignore[attr-defined]
    return id


async def dpage_close(id: str) -> None:
    if id in active_pages:
        page = active_pages[id]
        await safe_close_page(page)
        del active_pages[id]


async def dpage_check(id: str):
    TICK = 1  # seconds
    TIMEOUT = 120  # seconds
    max = TIMEOUT // TICK

    is_remote = is_remote_browser(id)
    remote_parts = id.split("--", 1) if is_remote else None
    browser: zd.Browser | None = None
    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    probe_patterns = load_distillation_patterns(path)

    for iteration in range(max):
        logger.debug(f"Checking dpage {id}: {iteration + 1} of {max}")
        await asyncio.sleep(TICK)

        if id in completed_signins:
            completed_signins.discard(id)
            return True

        if not is_remote or remote_parts is None:
            continue

        browser_id, target_id = remote_parts
        if browser is None:
            browser = await get_remote_browser(browser_id)
        if browser is None:
            continue

        page = _find_tab(browser, target_id)
        if page is None:
            browser = None
            continue

        try:
            terminated = await _probe_page(
                page=page, browser=browser, timeout=2, patterns=probe_patterns
            )
            if terminated:
                return True
        except Exception as e:
            logger.warning(f"Remote probe failed for {id}: {e}")
            browser = None

    return None


async def dpage_finalize(id: str):
    if browser := browser_manager.get_incognito_browser(id):
        await terminate_zendriver_browser(browser)
        browser_manager.remove_incognito_browser(id)
        return True

    if is_remote_browser(id):
        browser_id, _ = id.split("--")
        if browser := await get_remote_browser(browser_id):
            await terminate_remote_browser(browser)
            return True

    raise ValueError(f"Browser profile for signin {id} not found in incognito browser profiles")


def render(content: str, options: dict[str, str] | None = None) -> str:
    """Render HTML template with content and options."""
    if options is None:
        options = {}

    title = options.get("title", DEFAULT_TITLE)
    action = options.get("action", "")
    error_code = options.get("error_code", None)

    return render_form(content, title, action, error_code)


# Since the browser can't redirect from GET to POST,
# we'll use an auto-submit form to do that.
def redirect(id: str) -> HTMLResponse:
    return HTMLResponse(f"""
    <!DOCTYPE html>
    <html>
    <body>
      <form id="redirect" action="/dpage/{id}" method="post">
      </form>
      <script>document.getElementById('redirect').submit();</script>
    </body>
    </html>
    """)


@router.get("", response_class=HTMLResponse)
@router.get("/{id}", response_class=HTMLResponse)
async def get_dpage(id: str | None = None) -> HTMLResponse:
    if id:
        if id in active_pages:
            return redirect(id)
        elif is_remote_browser(id):
            return redirect(id)

    raise HTTPException(status_code=400, detail="Missing page id")


FINISHED_MSG = "Finished! You can close this window now."


@router.post("/{id}", response_class=HTMLResponse)
async def post_dpage(id: str, request: Request) -> HTMLResponse:
    page: zd.Tab | None = None

    if id in active_pages:
        page = active_pages[id]

    if is_remote_browser(id):
        browser_id, page_id = id.split("--")
        browser = await get_remote_browser(browser_id)
        if browser is None:
            raise HTTPException(status_code=404, detail="Remote browser not found")
        for tab in browser.tabs:
            if tab.target_id == page_id:
                page = tab
                break

    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")

    return await zen_post_dpage(page, id, request)


def is_local_address(host: str) -> bool:
    hostname = host.split(":")[0].lower().strip()
    try:
        ip = ipaddress.ip_address(hostname)
        return ip.is_loopback
    except ValueError:
        return hostname in ("localhost", "127.0.0.1")


def get_base_url() -> str:
    headers = get_http_headers(include_all=True)
    host = headers.get("x-forwarded-host") or headers.get("host")
    if host is None:
        logger.warning("Missing Host header; defaulting to localhost")
        base_url = "http://localhost:23456"
    else:
        default_scheme = "http" if is_local_address(host) else "https"
        scheme = headers.get("x-forwarded-proto", default_scheme)
        base_url = f"{scheme}://{host}"
    return base_url


def is_incognito_request(headers: dict[str, str]) -> bool:
    return headers.get("x-incognito", "0") == "1"


async def zen_post_dpage(page: zd.Tab, id: str, request: Request) -> HTMLResponse:
    if not is_remote_browser(id):
        browser_manager.update_last_active(id)

    form_data = await request.form()
    fields: dict[str, str] = {k: str(v) for k, v in form_data.items()}

    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    patterns = load_distillation_patterns(path)

    logger.info(f"Continuing distillation for page {id}...")
    logger.debug(f"Available distillation patterns: {len(patterns)}")

    TICK = 1  # seconds
    TIMEOUT = DEFAULT_DPAGE_POST_POLL_TIMEOUT
    max = TIMEOUT // TICK

    current = Match(name="", priority=-1, distilled="")

    if settings.LOG_LEVEL == "DEBUG":
        await zen_capture_page_artifacts(page, identifier=id, prefix="dpage_debug")

    # Force browser to complete rendering by evaluating document state
    try:
        await wait_for_ready_state(page, timeout=5)
        # Additional wait for any dynamic content/JavaScript to settle
        await page.sleep(1)
        logger.debug("Page ready state is complete")
    except Exception as e:
        logger.warning(f"Error waiting for page ready state: {e}")

    for iteration in range(max):
        logger.debug(f"Iteration {iteration + 1} of {max}")
        await asyncio.sleep(TICK)

        try:
            current_url = str(await page.evaluate("window.location.href", await_promise=True))
        except Exception:
            current_url = page.url
        hostname = str(urllib.parse.urlparse(current_url).hostname) if current_url else None
        match = await zen_distill(hostname, page, patterns)
        if not match:
            logger.info("No matched pattern found")
            continue

        distilled = match.distilled
        document = BeautifulSoup(distilled, "html.parser")

        title_element = BeautifulSoup(distilled, "html.parser").find("title")
        title = title_element.get_text() if title_element is not None else DEFAULT_TITLE
        action = f"/dpage/{id}"
        options = {"title": title, "action": action}
        inputs = document.find_all("input")
        pending_actions: list[dict[str, str]] = []

        if match.distilled == current.distilled:
            logger.info(f"Still the same: {match.name}")
            has_inputs = len(inputs) > 0
            max_reached = iteration == max - 1
            if max_reached and has_inputs:
                logger.info("Still the same after timeout and need inputs, render the page...")
                return HTMLResponse(render(str(document.find("body")), options))
            continue

        current = match

        if await terminate(distilled):
            logger.info("Finished!")

            error = await get_error(distilled)
            if error is not None:
                logger.info(
                    f"Distillation reported page error pattern; sign-in still marked complete for polling. Pattern name: {match.name}"
                )
                options["error_code"] = error

            if not is_remote_browser(id):
                completed_signins.add(id)
                await dpage_close(id)
            return HTMLResponse(render(FINISHED_MSG, options))

        names: list[str] = []

        if fields.get("button"):
            button = document.find("button", value=str(fields.get("button")))
            if button:
                logger.info(f"Clicking button button[value={fields.get('button')}]")
                await zen_autoclick(page, distilled, f"button[value={fields.get('button')}]")
                continue

        processed_radio_groups: set[str] = set()
        radio_names_for_expected: set[str] = set()
        expected_field_count = 0
        for input in inputs:
            if isinstance(input, Tag):
                name = input.get("name")
                input_type = input.get("type")

                if input_type == "radio":
                    if name is None:
                        continue
                    name_str = str(name)
                    if name_str not in radio_names_for_expected:
                        radio_names_for_expected.add(name_str)
                        expected_field_count += 1
                    if name_str in processed_radio_groups:
                        continue
                    value = fields.get(name_str)
                    if not value or len(str(value)) == 0:
                        logger.warning(f"No form data found for radio button group {name_str}")
                        continue
                    radio = document.find(
                        "input",
                        {"type": "radio", "name": name_str, "value": str(value)},
                    )
                    if not isinstance(radio, Tag):
                        logger.warning(f"No radio button found for group {name_str} value {value}")
                        continue
                    rgm = radio.get("gg-match")
                    if not rgm:
                        continue
                    selector, frame_selector = get_selector(str(rgm))
                    config = getattr(page, "element_config", None)
                    radio_element = await page_query_selector(
                        page,
                        selector if selector is not None else "",
                        iframe_selector=frame_selector,
                        config=config,
                    )
                    if radio_element:
                        logger.info(f"Handling radio button group {name}")
                        logger.info(f"Using form data {name_str}={value}")
                        await radio_element.click()
                        radio["checked"] = "checked"
                        current.distilled = str(document)
                        names.append(name_str)
                        processed_radio_groups.add(name_str)
                    continue

                expected_field_count += 1
                gg_match = input.get("gg-match")
                selector, frame_selector = get_selector(
                    str(gg_match) if gg_match is not None else ""
                )
                config = getattr(page, "element_config", None)
                name = input.get("name")
                input_type = input.get("type")

                if input_type == "checkbox" or input_type == "radio":
                    element = await page_query_selector(
                        page,
                        selector if selector is not None else "",
                        iframe_selector=frame_selector,
                        config=config,
                    )
                    if not element:
                        continue
                    if input_type == "checkbox":
                        if not name:
                            logger.warning(f"No name for the checkbox {gg_match}")
                            continue
                        value = fields.get(str(name))
                        checked = value and len(str(value)) > 0
                        names.append(str(name))
                        logger.info(f"Status of checkbox {name}={checked}")
                        current_checked_value = (
                            element.element.get("checked") or element.element.get("value") == "true"
                        )
                        if current_checked_value != checked:
                            logger.info(f"Clicking checkbox {name} to set it to {checked}")
                            await element.click()
                    elif input_type == "radio":
                        if name is not None:
                            name_str = str(name)
                            value = fields.get(name_str)
                            if not value or len(value) == 0:
                                logger.warning(f"No form data found for radio button group {name}")
                                continue
                            radio = document.find("input", {"type": "radio", "value": str(value)})
                            if not radio or not isinstance(radio, Tag):
                                logger.warning(f"No radio button found with value {value}")
                                continue
                            logger.info(f"Handling radio button group {name}")
                            logger.info(f"Using form data {name}={value}")
                            radio_gg_match = str(radio.get("gg-match"))
                            selector, frame_selector = get_selector(radio_gg_match)
                            config = getattr(page, "element_config", None)
                            radio_element = await page_query_selector(
                                page,
                                selector if selector is not None else "",
                                iframe_selector=frame_selector,
                                config=config,
                            )
                            if radio_element:
                                await radio_element.click()
                                radio["checked"] = "checked"
                                current.distilled = str(document)
                                names.append(str(input.get("id")) if input.get("id") else "radio")
                elif name is not None:
                    name_str = str(name)
                    value = fields.get(name_str)
                    if value and len(value) > 0:
                        logger.info(f"Using form data {name}")
                        names.append(name_str)
                        input["value"] = value
                        current.distilled = str(document)
                        pending_actions.append({
                            "key": f"set:{name}:{len(pending_actions)}",
                            "kind": "set_value",
                            "selector": str(selector),
                            "value": str(value),
                        })
                        del fields[name_str]
                    else:
                        logger.info(f"No form data found for {name}")

        # Queue non-button auto-clicks so they can run in the same batch as field updates.
        for auto_click_target in document.select("[gg-autoclick]:not(button)"):
            auto_click_selector, _ = get_selector(str(auto_click_target.get("gg-match")))
            if auto_click_selector:
                pending_actions.append({
                    "key": f"click:auto:{len(pending_actions)}",
                    "kind": "click",
                    "selector": str(auto_click_selector),
                })

        should_submit = False
        SUBMIT_BUTTON = "button[gg-autoclick], button[type=submit]"
        if document.select(SUBMIT_BUTTON):
            if len(names) > 0 and expected_field_count == len(names):
                logger.info("Submitting form, all fields are filled...")
                for submit_button in document.select(SUBMIT_BUTTON):
                    submit_selector, _ = get_selector(str(submit_button.get("gg-match")))
                    if submit_selector:
                        pending_actions.append({
                            "key": f"click:submit:{len(pending_actions)}",
                            "kind": "click",
                            "selector": str(submit_selector),
                        })
                should_submit = True
            else:
                logger.warning("Not all form fields are filled")
                return HTMLResponse(render(str(document.find("body")), options))

        if len(pending_actions) > 0:
            action_results = await page_batch_actions(page, pending_actions)
            results = action_results if isinstance(action_results, dict) else {}

            # Fallback for failed/unexecuted actions to preserve behavior.
            for action in pending_actions:
                key = action.get("key")
                kind = action.get("kind")
                selector = action.get("selector")
                if (
                    not isinstance(key, str)
                    or not isinstance(kind, str)
                    or not isinstance(selector, str)
                ):
                    continue
                if results.get(key, False):
                    continue

                element = await page_query_selector(page, selector)
                if not element:
                    continue
                if kind == "click":
                    await element.click()
                elif kind == "set_value":
                    value = action.get("value")
                    await element.type_text(value if isinstance(value, str) else "")

            await asyncio.sleep(0.25)

        if should_submit:
            continue

    hostname_attr: str | None = getattr(page, "hostname", None)  # type: ignore[assignment]
    location = getattr(page, "url", "unknown")  # type: ignore[assignment]
    timeout_error = TimeoutError("Timeout reached in zen_post_dpage")

    await zen_report_distill_error(
        error=timeout_error,
        page=page,
        profile_id=id,
        location=location,
        hostname=hostname_attr or "unknown",
        iteration=max,
    )
    raise HTTPException(status_code=503, detail="Timeout reached")


async def zen_dpage_mcp_tool(
    initial_url: str,
    result_key: str,
    timeout: int = 2,
    config: ElementConfig | None = None,
) -> dict[str, Any]:
    """Generic MCP tool based on distillation with Zendriver

    Args:
        initial_url: The starting URL for distillation
        result_key: Key under which the distillation result will be placed
        timeout: Timeout for the distillation
        config: Optional ElementConfig for dpage_add
    """
    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    patterns = load_distillation_patterns(path)

    headers = get_http_headers(include_all=True)
    incognito = is_incognito_request(headers)
    signin_id = headers.get("x-signin-id") or None

    if signin_id and is_remote_browser(signin_id):
        return await remote_zen_dpage_mcp_tool(initial_url, result_key, timeout, config)

    if incognito:
        browser = await init_zendriver_browser(signin_id)
    else:
        browser = browser_manager.get_global_browser()
        if browser is None:
            logger.info("Creating global browser for Zendriver...")
            browser = await init_zendriver_browser()
            browser_manager.set_global_browser(browser)
            await get_new_page(browser)
            logger.info(f"Global browser created with id {browser.id}")  # type: ignore[attr-defined]

    if not incognito or signin_id is not None:
        # First, try without any interaction as this will work if the user signed in previously
        terminated, distilled, converted = await zen_run_distillation_loop(
            location=initial_url,
            patterns=patterns,
            browser=browser,
            timeout=timeout,
            interactive=False,
        )
        if terminated:
            distillation_result = converted if converted is not None else distilled
            return {result_key: distillation_result}

    page = await get_new_page(browser)
    page.hostname = urllib.parse.urlparse(initial_url).hostname  # type: ignore[attr-defined]

    id = await dpage_add(
        page,
        initial_url,
        browser.id,  # type: ignore[attr-defined]
        config=config,
    )

    if incognito:
        browser_manager.set_incognito_browser(id, browser)

    base_url = get_base_url()
    url = f"{base_url}/dpage/{id}"
    logger.info(f"Continue with the sign in at {url}", extra={"url": url, "id": id})
    return {
        "url": url,
        "message": f"Continue to sign in in your browser at {url}.",
        "signin_id": id,
        "system_message": (
            f"Try open the url {url} in a browser with a tool if available."
            "Give the url to the user so the user can open it manually in their browser."
            "Then call check_signin with the signin_id to see when sign-in finished (it does not return tool data). "
            "Call the same MCP tool again to get the result. "
            "For incognito or explicit session flows, send the x-signin-id header on the retry. "
        ),
    }


async def zen_dpage_with_action(
    initial_url: str,
    action: Any,
    timeout: int = 2,
    config: ElementConfig | None = None,
) -> dict[str, Any]:
    """Execute an action after signin completion with Zendriver.

    Args:
        initial_url: URL to navigate to
        action: Async function that receives a Page and returns a dict
        timeout: Timeout in seconds
    Returns:
        Dict with result or signin flow info
    """
    headers = get_http_headers(include_all=True)
    incognito = is_incognito_request(headers)
    signin_id = headers.get("x-signin-id") or None

    # Try existing session — explicit signin_id, or stateless probe on global browser
    global_browser = browser_manager.get_global_browser()

    # 2a. Explicit signin_id: reuse that session directly.
    if signin_id:
        browser = await init_zendriver_browser(signin_id)
        page: zd.Tab | None = None
        try:
            page = await get_new_page(browser)
            await zen_navigate_with_retry(page, initial_url)
            result = await _run_action_with_timeout(action, page, browser)
            await safe_close_page(page)
            logger.info("Action succeeded with existing signin_id session!")
            return result
        except TimeoutError:
            if page is not None:
                await safe_close_page(page)
            raise
        except Exception as e:
            logger.info(f"zen_dpage_with_action failed with signin_id session: {e}")

    # 2b. Stateless probe on the shared global browser.
    if not signin_id and global_browser and not incognito:
        result = await _try_action_with_probe(global_browser, initial_url, action, timeout)
        if result is not None:
            return result

    # User not signed in - create interactive signin flow (client retries tool after check_signin)
    browser_instance: zd.Browser
    if incognito:
        browser_instance = await init_zendriver_browser(signin_id)
    else:
        if browser_manager.get_global_browser() is None:
            logger.info("Creating global browser for Zendriver signin flow...")
            global_browser = await init_zendriver_browser()
            browser_manager.set_global_browser(global_browser)
            await get_new_page(global_browser)
        browser_instance = browser_manager.get_global_browser()  # type: ignore

    page = await get_new_page(browser_instance)
    page.hostname = urllib.parse.urlparse(initial_url).hostname  # type: ignore

    id = await dpage_add(
        page,
        initial_url,
        browser_instance.id,  # type: ignore[attr-defined]
        config=config,
    )

    if incognito:
        browser_manager.set_incognito_browser(id, browser_instance)

    response = _signin_flow_response(id)
    logger.info(
        f"zen_dpage_with_action: Continue with sign in at {response['url']}",
        extra={"url": response["url"], "id": id},
    )
    return response


async def remote_zen_dpage_mcp_tool(
    initial_url: str,
    result_key: str,
    timeout: int = 2,
    config: ElementConfig | None = None,
) -> dict[str, Any]:
    """Generic MCP tool based on distillation with remote Zendriver"""
    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    patterns = load_distillation_patterns(path)

    headers = get_http_headers(include_all=True)
    signin_id = headers.get("x-signin-id") or None
    incognito = is_incognito_request(headers)

    browser = None
    page = None

    if signin_id:
        browser_id, _ = signin_id.split("--")
        browser = await get_remote_browser(browser_id)
        if browser is None:
            raise HTTPException(status_code=400, detail="Remote browser not found")
        logger.info(f"Continue with browser {browser_id} (signed in, opening new page")
        page = await get_new_page(browser)
        dpage_id = f"{browser_id}--{page.target_id}"
    elif incognito:
        prefix = "E"  # for Ephemeral
        browser_id = prefix + generate(FRIENDLY_CHARS, 7)
        browser = await create_remote_browser(
            browser_id, target_domain=_target_domain_from_initial_url(initial_url)
        )
        page = await get_new_page(browser)
        dpage_id = f"{browser_id}--{page.target_id}"
        logger.info(f"Start with an ephemeral browser {browser_id}")
    else:
        user_id = get_auth_user().user_id
        browser_id: str = user_id
        browser = await get_remote_browser(browser_id)
        if browser is None:
            browser = await create_remote_browser(
                browser_id, target_domain=_target_domain_from_initial_url(initial_url)
            )
        page = await get_new_page(browser)
        dpage_id = f"{browser_id}--{page.target_id}"
        logger.info(f"For user {user_id}: using browser {browser_id}")

    logger.info(f"Navigating remote browser to {initial_url}")
    await zen_navigate_with_retry(page, initial_url)

    terminated, distilled, converted = await zen_run_distillation_loop(
        location=initial_url,
        patterns=patterns,
        browser=browser,
        timeout=timeout,
        interactive=False,
        close_page=False,
        page=page,
    )
    if terminated:
        await safe_close_page(page)
        distillation_result = converted if converted is not None else distilled
        return {result_key: distillation_result}

    page.hostname = urllib.parse.urlparse(initial_url).hostname  # type: ignore[attr-defined]

    base_url = get_base_url()
    url = f"{base_url}/dpage/{dpage_id}"
    logger.info(f"Continue with the sign in at {url}", extra={"url": url, "id": dpage_id})
    return {
        "url": url,
        "message": f"Continue to sign in in your browser at {url}.",
        "signin_id": dpage_id,
        "system_message": (
            f"Try open the url {url} in a browser with a tool if available. "
            "Give the url to the user so the user can open it manually in their browser. "
            "Then call check_signin with the signin_id to see when sign-in finished (it does not return tool data). "
            "Call the same MCP tool again to get the result. "
            "For incognito or explicit session flows, send the x-signin-id header on the retry. "
        ),
    }


async def remote_zen_dpage_with_action(
    initial_url: str,
    action: Any,
    timeout: int = 2,
    config: ElementConfig | None = None,
) -> dict[str, Any]:
    """Execute an action after signin completion with remote Zendriver."""
    headers = get_http_headers(include_all=True)
    signin_id = headers.get("x-signin-id") or None
    incognito = is_incognito_request(headers)

    # Probe any existing browser for an authenticated session before opening dpage.
    probe_browser = None
    if signin_id and is_remote_browser(signin_id):
        probe_browser = await get_remote_browser(signin_id.split("--")[0])
    elif not incognito:
        probe_browser = await get_remote_browser(str(get_auth_user().user_id))
    if probe_browser is not None:
        result = await _try_action_with_probe(probe_browser, initial_url, action, timeout)
        if result is not None:
            return result

    # Create interactive sign-in flow (client retries tool after check_signin)
    page = None
    if signin_id and is_remote_browser(signin_id):
        browser_id, page_id = signin_id.split("--")
        dpage_id = signin_id
        browser = await get_remote_browser(browser_id)
        if browser is None:
            raise HTTPException(status_code=400, detail="Remote browser not found")
        page = _find_tab(browser, page_id)
        if page is None:
            logger.info(f"Tab {page_id} no longer exists, opening new tab on browser {browser_id}")
            page = await get_new_page(browser)
            dpage_id = f"{browser_id}--{page.target_id}"
        else:
            logger.info(f"Continue with remote browser {browser_id} and page {page_id}")
    elif incognito:
        prefix = "E"
        browser_id = prefix + generate(FRIENDLY_CHARS, 7)
        browser = await create_remote_browser(
            browser_id, target_domain=_target_domain_from_initial_url(initial_url)
        )
        page = await get_new_page(browser)
        dpage_id = f"{browser_id}--{page.target_id}"
        logger.info(f"Start with ephemeral remote browser {browser_id}")
    else:
        user_id = get_auth_user().user_id
        browser_id = user_id
        browser = await get_remote_browser(browser_id)
        if browser is None:
            browser = await create_remote_browser(
                browser_id, target_domain=_target_domain_from_initial_url(initial_url)
            )
        page = await get_new_page(browser)
        dpage_id = f"{browser_id}--{page.target_id}"
        logger.info(f"For user {user_id}: using remote browser {browser_id}")

    await zen_navigate_with_retry(page, initial_url)
    page.hostname = urllib.parse.urlparse(initial_url).hostname  # type: ignore[attr-defined]

    response = _signin_flow_response(dpage_id)
    logger.info(
        f"remote_zen_dpage_with_action: Continue with sign in at {response['url']}",
        extra={"url": response["url"], "id": dpage_id},
    )
    return response
