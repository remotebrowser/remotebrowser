import asyncio
import json
import os
import re
import urllib.parse
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from glob import glob
from pathlib import Path
from typing import Any, Callable, Coroutine, cast
from urllib.parse import urlunparse

import sentry_sdk
import zendriver as zd
from bs4 import BeautifulSoup
from bs4.element import Tag
from loguru import logger
from nanoid import generate

from getgather.browser import (
    create_remote_browser,
    get_new_page,
    page_batch_extract,
    page_query_selector,
    terminate_remote_browser,
    wait_for_ready_state,
    zen_navigate_with_retry,
)
from getgather.config import FRIENDLY_CHARS, settings


@dataclass
class Pattern:
    name: str
    pattern: BeautifulSoup


@dataclass
class Match:
    name: str
    priority: int
    distilled: str


ConversionResult = list[dict[str, str | list[str]]]

ErrorReporter = Callable[..., Coroutine[Any, Any, None]]

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


def make_error_reporter(browser: zd.Browser, location: str | None = None) -> ErrorReporter:
    profile_id = cast(str, browser.id)  # type: ignore[attr-defined]

    async def _report(
        *,
        error: Exception,
        page: zd.Tab | None,
        hostname: str,
        iteration: int,
    ) -> None:
        await zen_report_distill_error(
            error=error,
            page=page,
            profile_id=profile_id,
            location=location or "",
            hostname=hostname,
            iteration=iteration,
        )

    return _report


async def distill(
    hostname: str | None, page: zd.Tab, patterns: list[Pattern], reload_on_error: bool = True
) -> Match | None:
    result: list[tuple[Match, list[str]]] = []
    pattern_runs: list[tuple[str, int, BeautifulSoup, list[dict[str, object]]]] = []
    all_batch_queries: list[dict[str, object]] = []
    next_query_key = 0

    for item in patterns:
        name = item.name
        pattern = deepcopy(item.pattern)

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
                    input_type = str(target.get("type", "")).lower()
                    if tag in ["input", "textarea", "select"] and input_type != "radio":
                        value = source.get("value", "")
                        target["value"] = value if isinstance(value, str) else ""
                match_count += 1
                continue

            if optional:
                logger.debug(f"Optional {selector} has no match")
                target.extract()
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


async def run_distillation_loop(
    *,
    location: str | None = None,
    patterns: list[Pattern],
    browser: zd.Browser,
    timeout: int = 15,
    page: zd.Tab | None = None,
    error_reporter: ErrorReporter | None = None,
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
                if error_reporter is not None:
                    await error_reporter(
                        error=error,
                        page=page,
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
                    return (True, distilled, converted)

                current.distilled = distilled

        else:
            logger.debug(f"No matched pattern found")

    if error_reporter is not None:
        await error_reporter(
            error=ValueError("No matched pattern found"),
            page=page,
            hostname=hostname,
            iteration=max,
        )
    return (False, current.distilled, None)


async def short_lived_mcp_tool(
    location: str,
    pattern_wildcard: str,
    result_key: str,
    url_hostname: str,
    timeout: int = 15,
) -> tuple[bool, dict[str, Any]]:
    browser = await create_remote_browser(browser_id=generate(FRIENDLY_CHARS, 6))

    path = os.path.join(os.path.dirname(__file__), "mcp", "patterns", pattern_wildcard)
    patterns = load_distillation_patterns(path)
    try:
        terminated, distilled, converted = await run_distillation_loop(
            location=location, patterns=patterns, browser=browser, timeout=timeout
        )
    finally:
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
