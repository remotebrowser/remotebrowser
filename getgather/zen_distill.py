import asyncio
import json
import os
import platform
import random
import re
import urllib.parse
from dataclasses import dataclass
from datetime import datetime
from glob import glob
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlunparse

import sentry_sdk
import websockets
import zendriver as zd
from bs4 import BeautifulSoup
from bs4.element import Tag
from loguru import logger
from nanoid import generate
from zendriver.core.connection import ProtocolException

from getgather.browser.chromefleet import create_remote_browser, terminate_remote_browser
from getgather.browser.proxy import setup_proxy
from getgather.browser.resource_blocker import (
    blocked_domains,
    images_allowed_for_request_url,
    load_blocklists,
    should_be_blocked,
)
from getgather.config import FRIENDLY_CHARS, settings
from getgather.container_utils import check_x_server_available
from getgather.mcp.browser import (
    browser_manager,
    remove_profile_dir,
    terminate_zendriver_browser,
)
from getgather.request_info import request_info


@dataclass
class Pattern:
    name: str
    pattern: BeautifulSoup


@dataclass
class Match:
    name: str
    priority: int
    distilled: str


@dataclass
class ElementConfig:
    """Configuration for element typing operations."""

    # Typing configuration
    typing_clear_delay: float = 0.1
    typing_char_delay_min: float = 0.01
    typing_char_delay_max: float = 0.05


ConversionResult = list[dict[str, str | list[str]]]

_CREDENTIALS_BLOCK_SCRIPT = r"""
(() => {
  "use strict";

  if (!window.CredentialsContainer || !navigator.credentials) return;

  Object.defineProperty(CredentialsContainer.prototype, "get", {
    configurable: true,
    writable: true,
    value: function () {
      return Promise.reject(
        new DOMException("Credentials API blocked", "NotAllowedError")
      );
    },
  });
})();
"""

NETWORK_ERROR_PATTERNS = (
    "err-timed-out",
    "err-ssl-protocol-error",
    "err-tunnel-connection-failed",
    "err-proxy-connection-failed",
    "err-service-unavailable",
    "err-connection-closed",
    "err-empty-response",
    "err-http-protocol-error",
    "amazon-something-error-ca",
)


def get_selector(input_selector: str | None) -> tuple[str | None, str | None]:
    pattern = r"^(iframe(?:[^\s]*\[[^\]]+\]|[^\s]+))\s+(.+)$"
    if not input_selector:
        return None, None
    match = re.match(pattern, input_selector)
    if not match:
        return input_selector, None
    return match.group(2), match.group(1)


def extract_value(item: Tag, attribute: str | None = None) -> str:
    """Extract text or attribute value from a BeautifulSoup Tag."""
    if attribute:
        value = item.get(attribute)
        if isinstance(value, list):
            value = value[0] if value else ""
        return value.strip() if isinstance(value, str) else ""
    return item.get_text(strip=True)


def _load_converter_from_file(json_path: Path) -> dict[str, Any] | None:
    """Load converter configuration from a JSON file."""
    if not json_path.exists():
        return None

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            return cast(dict[str, Any], json.load(f))
    except Exception as error:
        logger.warning(f"Failed to load converter from {json_path}: {error}")
        return None


async def convert(distilled: str, pattern_path: str | None = None):
    """Convert distilled HTML to structured data"""
    document = BeautifulSoup(distilled, "html.parser")
    converter = None

    if pattern_path:
        stops = document.find_all(attrs={"gg-stop": True})
        for stop in stops:
            if isinstance(stop, Tag):
                gg_convert = stop.get("gg-convert")
                if isinstance(gg_convert, str) and gg_convert.strip():
                    pattern_dir = Path(pattern_path).parent
                    json_path = pattern_dir / gg_convert.strip()
                    logger.info(f"Loading converter from gg-convert: {json_path}")
                    converter = _load_converter_from_file(json_path)
                    if converter:
                        logger.info(f"Loaded converter from {json_path}")
                        break

    if converter is None:
        snippet = document.find("script", {"type": "application/json"})
        if snippet:
            script_content = snippet.get_text().strip()
            if script_content:
                logger.info("Found converter in HTML script tag")
                try:
                    converter = json.loads(script_content)
                except Exception as error:
                    logger.error(f"Failed to parse converter from HTML: {error}")
                    return None

    if converter is None:
        logger.debug("No converter found")
        return None

    # Perform conversion
    try:
        rows_selector = converter.get("rows", "")
        if not isinstance(rows_selector, str) or not rows_selector:
            logger.warning("Converter missing 'rows' selector")
            return None

        raw_columns = converter.get("columns", [])
        if not isinstance(raw_columns, list):
            logger.warning("Converter 'columns' must be a list")
            return None
        columns = cast(list[dict[str, Any]], raw_columns)

        logger.info(f"Converting using converter with {len(columns)} columns")
        rows = document.select(str(rows_selector))
        logger.info(f"Found {len(rows)} rows")

        converted: ConversionResult = []
        for el in rows:
            kv: dict[str, str | list[str]] = {}
            for col_dict in columns:
                name = col_dict.get("name")
                selector = col_dict.get("selector")
                if not name or not selector:
                    continue

                attribute = col_dict.get("attribute")
                kind = col_dict.get("kind")

                if kind == "list":
                    items = el.select(str(selector))
                    kv[name] = [extract_value(item, attribute) for item in items]
                else:
                    item = el.select_one(str(selector))
                    if item:
                        kv[name] = extract_value(item, attribute)

            if kv:
                converted.append(kv)

        logger.info(f"Conversion done: {len(converted)} entries")
        return converted
    except Exception as error:
        logger.error(f"Conversion error: {error}")
        return None


async def terminate(distilled: str) -> bool:
    document = BeautifulSoup(distilled, "html.parser")
    stops = document.find_all(attrs={"gg-stop": True})
    if len(stops) > 0:
        logger.info("Found stop elements, terminating session...")
        return True
    return False


async def get_error(distilled: str) -> str | None:
    document = BeautifulSoup(distilled, "html.parser")
    error_element = document.find(attrs={"gg-error": True})
    if error_element and isinstance(error_element, Tag):
        error_value = error_element.get("gg-error")
        logger.info(f"Found error element: {error_value}")
        if isinstance(error_value, str):
            return error_value
    return None


def load_distillation_patterns(path: str) -> list[Pattern]:
    patterns: list[Pattern] = []
    for name in glob(path, recursive=True):
        with open(name, "r", encoding="utf-8") as f:
            content = f.read()
        patterns.append(Pattern(name=name, pattern=BeautifulSoup(content, "html.parser")))
    return patterns


def _safe_fragment(value: str) -> str:
    """Convert a value to a safe filename fragment."""
    fragment = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-")
    return fragment or "distill"


async def wait_for_ready_state(
    page: zd.Tab,
    timeout: int = 10,
) -> bool:
    """
    Waits for the page to reach a certain ready state (interactive or complete).
    :param timeout: The maximum number of seconds to wait.
    :type timeout: int
    :raises asyncio.TimeoutError: If the timeout is reached before the ready state is reached.
    :return: True if the ready state is reached.
    :rtype: bool
    """
    loop = asyncio.get_event_loop()
    start_time = loop.time()

    while True:
        state = await page.evaluate("document.readyState")
        if state == "interactive" or state == "complete":
            return True

        if loop.time() - start_time > timeout:
            raise asyncio.TimeoutError("time ran out while waiting for load page until %s" % state)

        await asyncio.sleep(0.1)


async def capture_page_artifacts(
    page: zd.Tab,  # type: ignore[name-defined]
    *,
    identifier: str,
    prefix: str,
    capture_html: bool = True,
) -> tuple[Path, Path | None, str | None]:
    """Capture a screenshot (and optional HTML) for debugging/triage."""

    settings.screenshots_dir.mkdir(parents=True, exist_ok=True)

    base_identifier = _safe_fragment(identifier)
    base_prefix = _safe_fragment(prefix)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    token = generate(size=5)
    filename = f"{base_identifier}_{base_prefix}_{timestamp}_{token}.png"
    screenshot_path = settings.screenshots_dir / filename

    await page.save_screenshot(filename=str(screenshot_path), full_page=True)  # type: ignore[attr-defined]

    html_path: Path | None = None
    html_content: str | None = None
    if capture_html:
        try:
            html_content = await page.get_content()  # type: ignore[attr-defined]
        except Exception as exc:  # ignore navigation races during capture
            logger.debug(f"⚠️ Can't capture page content during navigation: {exc}")
        else:
            html_path = screenshot_path.with_suffix(".html")
            html_path.write_text(html_content, encoding="utf-8")

    logger.debug(
        "📸 Distill artifact saved",
        extra={
            "screenshot": f"file://{screenshot_path}",
            "html": f"file://{html_path}" if html_path else None,
        },
    )

    return screenshot_path, html_path, html_content


async def zen_report_distill_error(
    *,
    error: Exception,
    page: zd.Tab | None,  # type: ignore[name-defined]
    profile_id: str,
    location: str,
    hostname: str,
    iteration: int,
) -> None:
    screenshot_path: Path | None = None
    html_path: Path | None = None

    if page:
        try:
            screenshot_path, html_path, _ = await capture_page_artifacts(
                page,
                identifier=profile_id,
                prefix="distill_error",
            )
        except Exception as capture_error:
            logger.warning(f"Failed to capture distillation artifacts: {capture_error}")

    context: dict[str, Any] = {
        "location": location,
        "hostname": hostname,
        "iteration": iteration,
    }

    logger.error(
        "Distillation error",
        extra={
            "profile_id": profile_id,
            "location": location,
            "iteration": iteration,
            "screenshot": f"file://{screenshot_path}" if screenshot_path else None,
        },
    )

    if settings.SENTRY_DSN:
        with sentry_sdk.isolation_scope() as scope:
            scope.set_context("distill", context)
            if screenshot_path:
                scope.add_attachment(
                    filename=screenshot_path.name,
                    path=str(screenshot_path),
                )
            if html_path:
                scope.add_attachment(
                    filename=html_path.name,
                    path=str(html_path),
                )

            sentry_sdk.capture_exception(error)


async def install_proxy_handler(username: str, password: str, page: zd.Tab):
    """Install proxy authentication handler for the page.

    Note: This only handles authentication challenges. Request continuation
    is handled by the resource blocker in get_new_page().
    """

    async def auth_challenge_handler(event: zd.cdp.fetch.AuthRequired):
        logger.debug("Supplying proxy authentication...")
        await page.send(
            zd.cdp.fetch.continue_with_auth(
                request_id=event.request_id,
                auth_challenge_response=zd.cdp.fetch.AuthChallengeResponse(
                    response="ProvideCredentials",
                    username=username,
                    password=password,
                ),
            )
        )

    page.add_handler(zd.cdp.fetch.AuthRequired, auth_challenge_handler)  # type: ignore[arg-type]
    await page.send(zd.cdp.fetch.enable(handle_auth_requests=True))


async def _create_zendriver_browser(id: str | None = None) -> zd.Browser:
    if id is None:
        id = generate(FRIENDLY_CHARS, 6)

    user_data_dir: Path = settings.profiles_dir / id
    logger.info(
        f"Launching Zendriver browser with user_data_dir: {user_data_dir}",
        extra={"profile_id": id},
    )

    browser_args = [
        "--start-maximized",
        "--no-dbus",  # avoids chromium probing real DBus sockets inside the container which are not needed
    ]

    proxy = await setup_proxy(id, request_info.get())
    if proxy:
        proxy_server = proxy["server"]
        browser_args.append(f"--proxy-server={proxy_server}")

    MAX_START_ATTEMPTS = 3
    BASE_RETRY_DELAY = 0.5
    last_error: Exception | None = None
    if platform.system() == "Linux":
        try:
            await check_x_server_available()
        except Exception as e:
            logger.error(f"X server not available: {e}", extra={"profile_id": id})
            raise
    for attempt in range(1, MAX_START_ATTEMPTS + 1):
        try:
            browser = await zd.start(
                user_data_dir=str(user_data_dir),
                sandbox=False,  # Required when running as root; safer than --no-sandbox arg
                browser_args=browser_args,
            )
            browser.id = id  # type: ignore[attr-defined]
            return browser
        except Exception as e:
            last_error = e
            if attempt < MAX_START_ATTEMPTS:
                logger.warning(
                    "Browser start failed (attempt %s/%s): %s. Retrying...",
                    attempt,
                    MAX_START_ATTEMPTS,
                    e,
                    extra={"profile_id": id},
                )
                # Simple backoff to avoid retry storms
                await asyncio.sleep(BASE_RETRY_DELAY * attempt)

    logger.error(
        "Failed to start browser after %s attempts",
        MAX_START_ATTEMPTS,
        extra={"profile_id": id},
    )
    # Don't leave a partially-initialized profile dir behind
    remove_profile_dir(user_data_dir)
    raise last_error or RuntimeError("Failed to start browser")


async def init_zendriver_browser(id: str | None = None) -> zd.Browser:
    if id is not None:
        if browser := browser_manager.get_incognito_browser(id):
            return browser
        else:
            raise ValueError(f"Browser profile for signin {id} not found")

    MAX_ATTEMPTS = 3
    IP_CHECK_URL = "https://ip.fly.dev/ip"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        logger.info(f"Creating a new Zendriver browser (attempt {attempt}/{MAX_ATTEMPTS})...")
        browser = await _create_zendriver_browser(id)

        try:
            logger.info(f"Validating browser at {IP_CHECK_URL}...")
            page = await get_new_page(browser)
            # Skip wait_for_ready_state for IP check - ip.fly.dev is a simple text page
            await zen_navigate_with_retry(page, IP_CHECK_URL, wait_for_ready=False)
            body = await page.select("body")
            if body:
                ip_address = body.text.strip()
                logger.info(f"Browser validated. IP address: {ip_address}")
            else:
                logger.info("Browser validated (could not extract IP)")
            return browser
        except Exception as e:
            logger.warning(f"Browser validation failed on attempt {attempt}: {e}")
            # Terminate (instead of just stop) so the profile dir is removed:
            # each retry creates a fresh profile, this one is never reused.
            try:
                await terminate_zendriver_browser(browser)
            except Exception:
                pass

    logger.error(f"Failed to get a working browser after {MAX_ATTEMPTS} attempts!")
    raise RuntimeError(f"Failed to get a working Zendriver browser after {MAX_ATTEMPTS} attempts!")


async def zen_navigate_with_retry(page: zd.Tab, url: str, wait_for_ready: bool = True) -> zd.Tab:
    """Navigate to URL with retry logic for resilient navigation.

    Args:
        page: Zendriver tab to navigate
        url: URL to navigate to
        wait_for_ready: Whether to wait for page ready state (default True).
            Set to False for simple pages that load instantly.

    Returns:
        The page after successful navigation

    Raises:
        Exception: If navigation fails after all retries
    """
    MAX_RETRIES = 3
    FIRST_TIMEOUT = 45  # seconds, extended for first attempt
    NORMAL_TIMEOUT = 30  # seconds, for retry attempts

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        timeout = FIRST_TIMEOUT if attempt == 0 else NORMAL_TIMEOUT
        try:

            async def navigate_and_wait() -> zd.Tab:
                _frame_id, _loader_id, error_text = await page.send(zd.cdp.page.navigate(url))

                # Check for navigation errors (connection refused, DNS failure, SSL errors, etc.)
                if error_text:
                    raise ConnectionError(f"Navigation failed: {error_text}")

                if not wait_for_ready:
                    return page

                # Wait for page to be interactive
                try:
                    await wait_for_ready_state(page)
                except Exception:
                    # If wait fails, that's okay - page might already be loaded
                    pass
                return page

            result = await asyncio.wait_for(navigate_and_wait(), timeout=timeout)
            return result
        except Exception as error:
            last_error = error
            if attempt < MAX_RETRIES - 1:
                logger.warning(
                    f"Navigation to {url} failed (attempt {attempt + 1}/{MAX_RETRIES}): {error}. "
                    f"Retrying in 1 second..."
                )
                await asyncio.sleep(1)
            else:
                logger.error(f"Failed to navigate to {url} after {MAX_RETRIES} attempts")

    # This should never be reached, but satisfies type checker
    raise last_error or Exception(f"Failed to navigate to {url}")


def is_local_browser(browser: zd.Browser) -> bool:
    return browser.config.host is None or browser.config.host in ("127.0.0.1", "localhost")


async def get_new_page(browser: zd.Browser) -> zd.Tab:
    page = await browser.get("about:blank", new_tab=True)

    if blocked_domains is None:
        await load_blocklists()

    async def handle_request(event: zd.cdp.fetch.RequestPaused) -> None:
        resource_type = event.resource_type
        request_url = event.request.url
        images_allowed = images_allowed_for_request_url(request_url)

        if resource_type == zd.cdp.network.ResourceType.IMAGE:
            logger.debug(
                f"Image request check: page_url={page.url!r}, request_url={request_url!r}, "
                f"images_allowed={images_allowed}"
            )

        deny_type = resource_type in [
            zd.cdp.network.ResourceType.MEDIA,
            zd.cdp.network.ResourceType.FONT,
        ] or (resource_type == zd.cdp.network.ResourceType.IMAGE and not images_allowed)
        deny_url = await should_be_blocked(request_url)
        should_deny = deny_type or deny_url

        if not should_deny:
            try:
                await page.send(zd.cdp.fetch.continue_request(request_id=event.request_id))
            except (ProtocolException, websockets.ConnectionClosedError) as e:
                if isinstance(e, ProtocolException) and (
                    "Invalid state for continueInterceptedRequest" in str(e)
                    or "Invalid InterceptionId" in str(e)
                    or "Fetch domain is not enabled" in str(e)
                ):
                    logger.debug(
                        f"Request already processed or invalid interception ID: {request_url}"
                    )
                elif isinstance(e, websockets.ConnectionClosedError):
                    logger.debug(f"Page closed while continuing request: {request_url}")
                else:
                    raise
            return

        kind = "URL" if deny_url else "resource"
        logger.trace(f" DENY {kind}: {request_url}")

        try:
            await page.send(
                zd.cdp.fetch.fail_request(
                    request_id=event.request_id,
                    error_reason=zd.cdp.network.ErrorReason.BLOCKED_BY_CLIENT,
                )
            )
        except (ProtocolException, websockets.ConnectionClosedError) as e:
            if isinstance(e, ProtocolException) and (
                "Invalid state for continueInterceptedRequest" in str(e)
                or "Invalid InterceptionId" in str(e)
                or "Fetch domain is not enabled" in str(e)
            ):
                logger.debug(f"Request already processed or invalid interception ID: {request_url}")
            elif isinstance(e, websockets.ConnectionClosedError):
                logger.debug(f"Page closed while blocking request: {request_url}")
            else:
                raise

    # Enable fetch domain to intercept requests. Will be overridden if proxy auth is set up.
    await page.send(zd.cdp.fetch.enable())
    page.add_handler(zd.cdp.fetch.RequestPaused, handle_request)  # type: ignore[reportUnknownMemberType]

    # Block the entire Credentials API before page for passkeys
    # Page domain must be enabled before addScriptToEvaluateOnNewDocument, otherwise CDP will reject the script
    await page.send(zd.cdp.page.enable())
    await page.send(
        zd.cdp.page.add_script_to_evaluate_on_new_document(
            source=_CREDENTIALS_BLOCK_SCRIPT, run_immediately=True
        )
    )

    if is_local_browser(browser):
        id = cast(str, browser.id)  # type: ignore[attr-defined]
        proxy = await setup_proxy(id, request_info.get())
        proxy_username = None
        proxy_password = None
        if proxy:
            proxy_username = proxy["username"]
            proxy_password = proxy["password"]
            if proxy_username or proxy_password:
                logger.debug("Setting up proxy authentication...")
                await install_proxy_handler(proxy_username or "", proxy_password or "", page)

    return page


async def safe_close_page(page: zd.Tab) -> None:
    """Safely close a page by disabling fetch domain first to prevent orphaned tasks.

    When page.close() is called while fetch handlers are pending, it can leave
    orphaned tasks waiting for CDP responses that will never arrive. This function
    disables the fetch domain first to clean up handlers before closing.
    """
    try:
        # Disable fetch domain to cancel pending request handlers
        await page.send(zd.cdp.fetch.disable())
        logger.debug("Fetch domain disabled before page close")
    except (ProtocolException, websockets.ConnectionClosedError) as e:
        # Page/connection already closed, which is fine
        logger.debug(f"Could not disable fetch (connection already closed): {e}")
    except Exception as e:
        # Log but don't fail - we still want to close the page
        logger.warning(f"Unexpected error disabling fetch domain: {e}")

    try:
        target = getattr(page, "target", None)
        raw_target_id = getattr(target, "target_id", None) or getattr(page, "target_id", None)
        normalized_target_id = (
            zd.cdp.target.TargetID(raw_target_id.split("@", 1)[-1])
            if isinstance(raw_target_id, str)
            else None
        )

        if normalized_target_id:
            await page.send(zd.cdp.target.close_target(target_id=normalized_target_id))
        else:
            await page.close()
        logger.warning("Page closed successfully")
    except Exception as e:
        logger.warning(f"Error closing page: {e}")


class Element:
    """Wrapper to handle both CSS and XPath selector differences for browser elements."""

    def __init__(
        self,
        element: zd.Element,
        css_selector: str | None = None,
        xpath_selector: str | None = None,
        config: ElementConfig | None = None,
    ):
        self.element = element
        self.tag = element.tag
        self.page = element.tab
        self.css_selector = css_selector
        self.xpath_selector = xpath_selector
        self.config = config or ElementConfig()

    async def inner_html(self) -> str:
        return await self.element.get_html()

    async def inner_text(self) -> str:
        return self.element.text_all

    async def is_visible(self) -> bool:
        try:
            selector = self.xpath_selector or self.css_selector
            if not selector:
                return False

            # Optimized: Single JavaScript evaluation with minimal operations
            escaped_selector = selector.replace("\\", "\\\\").replace('"', '\\"')

            if self.xpath_selector:
                # Use a more efficient check - combine all checks in one expression
                js_code = f"""
                    (() => {{
                        const el = document.evaluate("{escaped_selector}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        if (!el) return false;
                        const s = window.getComputedStyle(el);
                        return s.visibility !== "hidden" && s.display !== "none" && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
                    }})()
                """
            else:
                # Optimized: Single expression, no intermediate variables
                js_code = f"""
                    (() => {{
                        const el = document.querySelector("{escaped_selector}");
                        if (!el) return false;
                        const s = window.getComputedStyle(el);
                        return s.visibility !== "hidden" && s.display !== "none" && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
                    }})()
                """

            return bool(await self.page.evaluate(js_code))
        except Exception as e:
            logger.debug(f"is_visible check failed: {e}")
            return False

    async def click(self) -> None:
        if self.css_selector:
            await self.css_click()
        else:
            await self.xpath_click()
        await asyncio.sleep(0.25)

    async def select_option(self, value: str) -> None:
        # Only support CSS selectors for now
        if not self.css_selector:
            logger.warning("Cannot perform CSS select_option: no css_selector available")
            return
        logger.debug(f"Attempting JavaScript CSS select_option for {self.css_selector}")
        try:
            escaped_selector = self.css_selector.replace("\\", "\\\\").replace('"', '\\"')
            value_selector = f"option[value='{value}']"
            js_code = f"""
                (() => {{
                    const select = document.querySelector("{escaped_selector}");
                    const option = select?.querySelector("{value_selector}");
                    if (!select || !option) return false;

                    // Scroll into view
                    select.scrollIntoView({{ block: "center" }});

                    // Open dropdown (if needed)
                    select.dispatchEvent(new PointerEvent("pointerdown", {{ bubbles: true }}));
                    select.dispatchEvent(new PointerEvent("pointerup", {{ bubbles: true }}));
                    select.dispatchEvent(new MouseEvent("click", {{ bubbles: true, cancelable: true, view: window }}));

                    // Select the option
                    option.selected = true;

                    // Trigger change event
                    select.dispatchEvent(new Event("change", {{ bubbles: true }}));

                    return true;
                }})();
            """
            result = await self.page.evaluate(js_code)
            if result:
                logger.info(f"JavaScript CSS select_option succeeded for {self.css_selector}")
                return
            else:
                logger.warning(
                    f"JavaScript CSS select_option could not find element {self.css_selector}"
                )
        except Exception as js_error:
            logger.error(f"JavaScript CSS select_option failed: {js_error}")

        await asyncio.sleep(0.25)

    async def check(self) -> None:
        logger.error("TODO: Element#check")
        await asyncio.sleep(0.25)

    async def type_text(self, text: str) -> None:
        await self.element.clear_input_by_deleting()
        await asyncio.sleep(self.config.typing_clear_delay)
        await self.element.clear_input()
        await asyncio.sleep(self.config.typing_clear_delay)
        for char in text:
            await self.element.send_keys(char)
            await asyncio.sleep(
                random.uniform(self.config.typing_char_delay_min, self.config.typing_char_delay_max)
            )

    async def css_click(self) -> None:
        if not self.css_selector:
            logger.warning("Cannot perform CSS click: no css_selector available")
            return
        logger.debug(f"Attempting JavaScript CSS click for {self.css_selector}")
        try:
            escaped_selector = self.css_selector.replace("\\", "\\\\").replace('"', '\\"')
            js_code = f"""
            (() => {{
                const selector = "{escaped_selector}";
                function findInDocument(doc) {{
                    try {{
                        const el = doc.querySelector(selector);
                        if (el) return el;
                    }} catch (e) {{
                        // Cross-origin iframe → skip
                    }}
                    // Look inside all iframes of this document
                    const iframes = doc.querySelectorAll("iframe");
                    for (const frame of iframes) {{
                        try {{
                            const childDoc = frame.contentDocument || frame.contentWindow.document;
                            const found = findInDocument(childDoc);   // recursion
                            if (found) return found;
                        }} catch (e) {{
                            // Cross-origin iframe → skip
                        }}
                    }}
                    return null;
                }}
                const element = findInDocument(document);
                if (!element) return false;
                element.scrollIntoView({{ block: "center" }});
                element.dispatchEvent(new PointerEvent("pointerdown", {{ bubbles: true }}));
                element.dispatchEvent(new PointerEvent("pointerup", {{ bubbles: true }}));
                element.dispatchEvent(new MouseEvent("click", {{ bubbles: true, cancelable: true, view: window }}));
                return true;
            }})()
            """
            result = await self.page.evaluate(js_code)
            if result:
                logger.info(f"JavaScript CSS click succeeded for {self.css_selector}")
                return
            else:
                logger.warning(f"JavaScript CSS click could not find element {self.css_selector}")
        except Exception as js_error:
            logger.error(f"JavaScript CSS click failed: {js_error}")

    async def xpath_click(self) -> None:
        if not self.xpath_selector:
            logger.warning(f"Cannot perform XPath click: no xpath_selector available")
            return
        logger.debug(f"Attempting JavaScript XPath click for {self.xpath_selector}")
        try:
            escaped_selector = self.xpath_selector.replace("\\", "\\\\").replace('"', '\\"')
            js_code = f"""
            (() => {{
                let element = document.evaluate("{escaped_selector}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (!element) return false;
                element.scrollIntoView({{ block: "center" }});
                element.dispatchEvent(new PointerEvent("pointerdown", {{ bubbles: true }}));
                element.dispatchEvent(new PointerEvent("pointerup", {{ bubbles: true }}));
                element.dispatchEvent(new MouseEvent("click", {{ bubbles: true, cancelable: true, view: window }}));
                return true;
            }})()
            """
            result = await self.page.evaluate(js_code)
            if result:
                logger.info(f"JavaScript XPath click succeeded for {self.xpath_selector}")
                return
            else:
                logger.warning(
                    f"JavaScript XPath click could not find element {self.xpath_selector}"
                )
        except Exception as js_error:
            logger.error(f"JavaScript XPath click failed: {js_error}")


async def page_query_selector(
    page: zd.Tab,
    selector: str,
    timeout: float = 0,
    iframe_selector: str | None = None,
    skip_visibility_check: bool = False,
    config: ElementConfig | None = None,
) -> Element | None:
    try:
        if selector.startswith("//"):
            elements = await page.xpath(selector, timeout)
            if elements and len(elements) > 0:
                element = Element(elements[0], xpath_selector=selector, config=config)
                if skip_visibility_check or await element.is_visible():
                    return element
            return None

        if iframe_selector is not None:
            element = await page.select_all(selector, timeout=timeout, include_frames=True)
            if element and len(element) > 0:
                element = Element(element[0], css_selector=selector, config=config)
                if skip_visibility_check or await element.is_visible():
                    return element
        else:
            element = await page.select(selector, timeout=timeout)
            if element:
                element = Element(element, css_selector=selector, config=config)
                if skip_visibility_check or await element.is_visible():
                    return element
        return None
    except (asyncio.TimeoutError, Exception) as error:
        logger.warning(f"page_query_selector failed: {error}")
        sentry_sdk.capture_exception(error)
        return None


async def page_batch_extract(
    page: zd.Tab, queries: list[dict[str, object]]
) -> dict[str, dict[str, object]] | None:
    if len(queries) == 0:
        return {}

    payload = json.dumps(queries)
    js_code = f"""
    (() => {{
        const queries = {payload};
        const output = {{}};

        function isVisible(element) {{
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                rect.width > 0 &&
                rect.height > 0
            );
        }}

        function findCss(selector, doc, iframeSelector) {{
            try {{
                if (iframeSelector) {{
                    const iframe = doc.querySelector(iframeSelector);
                    if (iframe) {{
                        const childDoc = iframe.contentDocument || iframe.contentWindow.document;
                        const directIframeMatch = childDoc.querySelector(selector);
                        if (directIframeMatch) {{
                            return directIframeMatch;
                        }}
                        return findCss(selector, childDoc, null);
                    }}
                }}
            }} catch (error) {{
                return null;
            }}

            try {{
                const direct = doc.querySelector(selector);
                if (direct) return direct;
            }} catch (error) {{
                return null;
            }}

            const iframes = doc.querySelectorAll("iframe");
            for (const iframe of iframes) {{
                try {{
                    const childDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const nested = findCss(selector, childDoc, null);
                    if (nested) return nested;
                }} catch (error) {{}}
            }}

            return null;
        }}

        for (const query of queries) {{
            const selector = query?.selector;
            const iframeSelector = query?.iframe_selector;
            const queryKey = query?.query_key;
            if (typeof selector !== "string" || selector.length === 0) {{
                continue;
            }}
            if (typeof queryKey !== "string" || queryKey.length === 0) {{
                continue;
            }}

            let element = null;

            if (selector.startsWith("//")) {{
                try {{
                    element = document.evaluate(
                        selector,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    ).singleNodeValue;
                }} catch (error) {{
                    element = null;
                }}
            }} else {{
                const resolvedIframeSelector = typeof iframeSelector === "string" &&
                    iframeSelector.length > 0
                    ? iframeSelector
                    : null;
                element = findCss(selector, document, resolvedIframeSelector);
            }}

            if (!element || !isVisible(element)) {{
                output[queryKey] = {{ found: false }};
                continue;
            }}

            const tag = String(element.tagName || "").toLowerCase();
            const item = {{ found: true, tag }};

            if (query?.wants_html) {{
                item.html = element.innerHTML || "";
            }}
            if (query?.wants_text) {{
                item.text = element.innerText || "";
            }}
            if (query?.wants_value && ["input", "textarea", "select"].includes(tag)) {{
                const value = element.value;
                if (typeof value === "string") {{
                    item.value = value;
                }} else if (value == null) {{
                    item.value = "";
                }} else {{
                    item.value = String(value);
                }}
            }}

            output[queryKey] = item;
        }}

        return output;
    }})()
    """

    try:
        result = await page.evaluate(js_code)
        if isinstance(result, dict):
            return cast(dict[str, dict[str, object]], result)
    except Exception as error:
        logger.debug(f"Batch extract failed: {error}")
    return None


async def distill(
    hostname: str | None, page: zd.Tab, patterns: list[Pattern], reload_on_error: bool = True
) -> Match | None:
    result: list[tuple[Match, list[str]]] = []
    pattern_runs: list[tuple[str, int, BeautifulSoup, list[dict[str, object]]]] = []
    all_batch_queries: list[dict[str, object]] = []
    next_query_key = 0

    for item in patterns:
        name = item.name
        pattern = item.pattern

        root = pattern.find("html")
        gg_priority = root.get("gg-priority", "-1") if isinstance(root, Tag) else "-1"
        try:
            priority = int(str(gg_priority).lstrip("= "))
        except ValueError:
            priority = -1
        domain = root.get("gg-domain") if isinstance(root, Tag) else None

        if domain and hostname:
            local = "localhost" in hostname or "127.0.0.1" in hostname
            if isinstance(domain, str) and not local and domain.lower() not in hostname.lower():
                logger.trace(f"Skipping {name} due to mismatched domain {domain}")
                continue

        logger.debug(f"Checking {name} with priority {priority}")

        targets = pattern.find_all(attrs={"gg-match": True}) + pattern.find_all(
            attrs={"gg-match-html": True}
        )
        target_specs: list[dict[str, object]] = []

        for target in targets:
            if not isinstance(target, Tag):
                continue

            html_attr = target.get("gg-match-html")
            selector, iframe_selector = get_selector(
                str(html_attr if html_attr else target.get("gg-match"))
            )
            if not selector:
                continue

            is_html = html_attr is not None
            query_key = str(next_query_key)
            next_query_key += 1
            optional = target.get("gg-optional") is not None

            target_specs.append({
                "target": target,
                "selector": selector,
                "iframe_selector": iframe_selector,
                "html": is_html,
                "optional": optional,
                "query_key": query_key,
            })
            all_batch_queries.append({
                "query_key": query_key,
                "selector": selector,
                "iframe_selector": iframe_selector,
                "wants_html": is_html,
                "wants_text": not is_html,
                "wants_value": not is_html,
            })

        pattern_runs.append((name, priority, pattern, target_specs))

    safe_results: dict[str, dict[str, object]] = {}
    if all_batch_queries:
        batch_results = await page_batch_extract(page, all_batch_queries)
        safe_results = batch_results if isinstance(batch_results, dict) else {}

    for name, priority, pattern, target_specs in pattern_runs:
        found = True
        match_count = 0
        optional_visible_text: list[str] = []

        for spec in target_specs:
            target = spec.get("target")
            selector = spec.get("selector")
            query_key = spec.get("query_key")
            html = bool(spec.get("html"))
            optional = bool(spec.get("optional"))

            if not isinstance(target, Tag):
                continue
            if not isinstance(selector, str) or not isinstance(query_key, str):
                continue

            source = safe_results.get(query_key, {})
            source_found = bool(source.get("found"))

            if source_found:
                if optional:
                    text_content = ""
                    raw_text = source.get("text")
                    if isinstance(raw_text, str):
                        text_content = raw_text.strip()
                    if not text_content:
                        raw_value = source.get("value")
                        if isinstance(raw_value, str):
                            text_content = raw_value.strip()
                    if not text_content:
                        raw_html = source.get("html")
                        if isinstance(raw_html, str):
                            text_content = BeautifulSoup(raw_html, "html.parser").get_text(
                                " ", strip=True
                            )
                    if text_content:
                        optional_visible_text.append(text_content)
                if html:
                    target.clear()
                    html_content = source.get("html", "")
                    fragment = BeautifulSoup("<div>" + str(html_content) + "</div>", "html.parser")
                    if fragment.div:
                        for child in list(fragment.div.children):
                            child.extract()
                            target.append(child)
                else:
                    raw_text = source.get("text")
                    if isinstance(raw_text, str) and raw_text:
                        target.string = raw_text.strip()
                    tag = str(source.get("tag", "")).lower()
                    if tag in ["input", "textarea", "select"]:
                        value = source.get("value", "")
                        target["value"] = value if isinstance(value, str) else ""
                match_count += 1
                continue

            if optional:
                logger.debug(f"Optional {selector} has no match")
                continue
            found = False

        if found and match_count > 0:
            distilled = str(pattern)
            result.append((
                Match(
                    name=name,
                    priority=priority,
                    distilled=distilled,
                ),
                optional_visible_text,
            ))

    result = sorted(result, key=lambda x: x[0].priority)

    if len(result) == 0:
        logger.debug("No matches found")
        return None
    else:
        logger.debug(f"Number of matches: {len(result)}")
        for item, _optional_visible_text in result:
            logger.debug(f" - {item.name} with priority {item.priority}")
        match, optional_visible_text = result[0]

        browser_id = getattr(getattr(page, "browser", None), "id", None)

        logger.bind(
            event="distill_best_match",
            best_match_name=match.name,
            best_match_priority=match.priority,
            best_match_optional_visible_text=optional_visible_text,
            hostname=hostname,
            browser_id=browser_id,
        ).info("Best match selected")

        if reload_on_error and any(pattern in match.name for pattern in NETWORK_ERROR_PATTERNS):
            logger.info(f"Error pattern detected: {match.name}")
            try:
                await page.send(zd.cdp.page.reload())
                await wait_for_ready_state(page)
            except Exception as e:
                logger.warning(f"Failed to reload page: {e}")
            logger.info("Retrying distillation after error...")
            return await distill(hostname, page, patterns, reload_on_error=False)
        return match


async def autoclick(page: zd.Tab, distilled: str, expr: str):
    document = BeautifulSoup(distilled, "html.parser")
    elements = document.select(expr)
    for el in elements:
        selector, iframe_selector = get_selector(str(el.get("gg-match")))
        if selector:
            target = await page_query_selector(page, selector, iframe_selector=iframe_selector)
            if target:
                logger.debug(f"Clicking {selector}")
                await target.click()
            else:
                logger.warning(f"Selector {selector} not found, can't click on it")


async def get_url(page: zd.Tab) -> str | None:
    current_url = await page.evaluate("window.location.href", await_promise=True)
    if current_url:
        return str(current_url)
    return None


async def run_distillation_loop(
    *,
    location: str | None = None,
    patterns: list[Pattern],
    browser: zd.Browser,
    timeout: int = 15,
    interactive: bool = True,
    close_page: bool = True,
    page: zd.Tab | None = None,
    report_error: bool = True,
) -> tuple[bool, str, ConversionResult | None]:
    """Run the distillation loop with zendriver.

    Returns:
        terminated: bool indicating successful termination
        distilled: the raw distilled HTML
        converted: the converted JSON if successful, otherwise None
    """
    if len(patterns) == 0:
        logger.error("No distillation patterns provided")
        raise ValueError("No distillation patterns provided")

    hostname = (location and urllib.parse.urlparse(location).hostname) or ""

    if page is None:
        page = await get_new_page(browser)
        logger.info(f"Navigating to {location}")
        if location:
            try:
                await zen_navigate_with_retry(page, location)
            except Exception as error:
                # Error already logged by retry wrapper, just report and re-raise
                await zen_report_distill_error(
                    error=error,
                    page=page,
                    profile_id=browser.id,  # type: ignore[attr-defined]
                    location=location,
                    hostname=hostname,
                    iteration=0,
                )
                raise ValueError(f"Failed to navigate to {location}: {error}")

    TICK = 1  # seconds
    max = timeout // TICK

    current = Match(name="", priority=-1, distilled="")

    for iteration in range(max):
        logger.debug(f"Iteration {iteration + 1} of {max}")
        await asyncio.sleep(TICK)

        try:
            current_url = str(await page.evaluate("window.location.href", await_promise=True))
            hostname = urllib.parse.urlparse(current_url).hostname or ""
        except Exception:
            pass  # keep previous hostname

        match = await distill(hostname, page, patterns)
        if match:
            if match.distilled == current.distilled:
                logger.debug(f"Still the same: {match.name}")
            else:
                distilled = match.distilled
                current = match

                if await terminate(distilled):
                    converted = await convert(distilled, pattern_path=match.name)
                    if close_page:
                        await safe_close_page(page)
                    return (True, distilled, converted)

                if interactive:
                    await autoclick(page, distilled, "[gg-autoclick]")
                    await autoclick(page, distilled, "button[type=submit]")

                current.distilled = distilled

        else:
            logger.debug(f"No matched pattern found")

    if report_error:
        await zen_report_distill_error(
            error=ValueError("No matched pattern found"),
            page=page,
            profile_id=browser.id,  # type: ignore[attr-defined]
            location=location or "",
            hostname=hostname,
            iteration=max,
        )
    if close_page:
        await safe_close_page(page)
    return (False, current.distilled, None)


async def short_lived_mcp_tool(
    location: str,
    pattern_wildcard: str,
    result_key: str,
    url_hostname: str,
) -> tuple[bool, dict[str, Any]]:
    browser = await create_remote_browser(browser_id=generate(FRIENDLY_CHARS, 6))

    path = os.path.join(os.path.dirname(__file__), "mcp", "patterns", pattern_wildcard)
    patterns = load_distillation_patterns(path)
    terminated, distilled, converted = await run_distillation_loop(
        location=location, patterns=patterns, browser=browser
    )
    await terminate_remote_browser(browser)

    result: dict[str, Any] = {result_key: converted if converted else distilled}
    if result_key in result:
        items_value = result[result_key]
        if isinstance(items_value, list):
            for item in cast(list[dict[str, Any]], items_value):
                if "link" in item:
                    link = cast(str, item["link"])
                    parsed = urllib.parse.urlparse(link)
                    netloc: str = parsed.netloc if parsed.netloc else url_hostname
                    url: str = urlunparse((
                        "https",
                        netloc,
                        parsed.path,
                        parsed.params,
                        parsed.query,
                        parsed.fragment,
                    ))
                    item["url"] = url
    return terminated, result


async def page_batch_actions(page: zd.Tab, actions: list[dict[str, str]]) -> dict[str, bool] | None:
    if len(actions) == 0:
        return {}

    payload = json.dumps(actions)
    js_code = f"""
    (async () => {{
        const actions = {payload};
        const output = {{}};

        function findCss(selector, doc) {{
            try {{
                const direct = doc.querySelector(selector);
                if (direct) return direct;
            }} catch (error) {{
                return null;
            }}

            const iframes = doc.querySelectorAll("iframe");
            for (const iframe of iframes) {{
                try {{
                    const childDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const nested = findCss(selector, childDoc);
                    if (nested) return nested;
                }} catch (error) {{
                    // Cross-origin iframe.
                }}
            }}
            return null;
        }}

        for (const action of actions) {{
            const key = action?.key;
            const kind = action?.kind;
            const selector = action?.selector;
            if (typeof key !== "string" || key.length === 0) {{
                continue;
            }}
            if (typeof selector !== "string" || selector.length === 0) {{
                output[key] = false;
                continue;
            }}

            let element = null;
            if (selector.startsWith("//")) {{
                try {{
                    element = document.evaluate(
                        selector,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    ).singleNodeValue;
                }} catch (error) {{
                    element = null;
                }}
            }} else {{
                element = findCss(selector, document);
            }}

            if (!element) {{
                output[key] = false;
                continue;
            }}

            try {{
                if (kind === "click") {{
                    element.click();
                    output[key] = true;
                }} else if (kind === "set_value") {{
                    const value = typeof action?.value === "string" ? action.value : "";
                    const requestedDelay = Number(action?.typing_delay_ms);
                    const typingDelayMs = Number.isFinite(requestedDelay)
                        ? Math.max(0, Math.min(250, requestedDelay))
                        : 25;
                    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype,
                        "value"
                    )?.set;
                    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        "value"
                    )?.set;

                    const setNativeValue = (el, nextValue) => {{
                        if (el instanceof HTMLInputElement && nativeInputValueSetter) {{
                            nativeInputValueSetter.call(el, nextValue);
                        }} else if (el instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {{
                            nativeTextAreaValueSetter.call(el, nextValue);
                        }} else {{
                            el.value = nextValue;
                        }}
                    }};

                    element.focus();
                    element.dispatchEvent(new KeyboardEvent("keydown", {{ key: "Tab", bubbles: true }}));

                    setNativeValue(element, "");
                    element.dispatchEvent(
                        new InputEvent("input", {{
                            bubbles: true,
                            inputType: "deleteContentBackward",
                            data: null
                        }})
                    );

                    let currentValue = "";
                    for (const char of value) {{
                        element.dispatchEvent(new KeyboardEvent("keydown", {{ key: char, bubbles: true }}));
                        element.dispatchEvent(new KeyboardEvent("keypress", {{ key: char, bubbles: true }}));
                        currentValue += char;
                        setNativeValue(element, currentValue);
                        element.dispatchEvent(
                            new InputEvent("input", {{
                                bubbles: true,
                                inputType: "insertText",
                                data: char
                            }})
                        );
                        element.dispatchEvent(new KeyboardEvent("keyup", {{ key: char, bubbles: true }}));
                        if (typingDelayMs > 0) {{
                            await sleep(typingDelayMs);
                        }}
                    }}
                    element.dispatchEvent(new Event("change", {{ bubbles: true }}));
                    output[key] = true;
                }} else {{
                    output[key] = false;
                }}
            }} catch (error) {{
                output[key] = false;
            }}
        }}

        return output;
    }})()
    """

    try:
        result = await page.evaluate(js_code, await_promise=True)
        if isinstance(result, dict):
            return {str(k): bool(v) for k, v in result.items()}  # pyright: ignore[reportUnknownArgumentType, reportUnknownVariableType]
    except Exception as error:
        logger.error(f"Batch actions failed: {error}")
    return None
