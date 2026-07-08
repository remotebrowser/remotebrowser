import os
import urllib.parse
from pathlib import Path
from typing import Any, cast

import pytest
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from nanoid import generate
from pytest import MonkeyPatch

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[2]

ACME_HOSTNAME = "https://acme.fly.dev"

from getgather.browser import (
    create_remote_browser,
    get_new_page,
    page_batch_extract,
    terminate_remote_browser,
)
from getgather.config import FRIENDLY_CHARS, settings
from getgather.zen_distill import (
    Pattern,
    distill,
    load_distillation_patterns,
    make_error_reporter,
    run_distillation_loop,
)

DISTILL_PATTERN_LOCATIONS = {
    "/": "acme_home_page.html",
    "/auth/email-and-password": "acme_email_and_password.html",
    "/auth/email-then-password": "acme_email_only.html",
    "/auth/email-and-password-checkbox": "acme_email_and_password_checkbox.html",
    "/universal-error-test": "acme_universal_error_test.html",
}

SIGN_IN_PATTERN_ENDPOINTS = [
    "/auth/email-and-password",
    "/auth/email-and-password-checkbox",
    "/auth/email-then-password",
    "/auth/email-then-otp",
    "/auth/email-and-password-then-mfa",
]


@pytest.mark.asyncio
@pytest.mark.distill
@pytest.mark.parametrize(
    "location",
    list(DISTILL_PATTERN_LOCATIONS.keys()),
)
async def test_distill_form_fields(location: str):
    """Tests the distill function's most basic ability to match a simple pattern."""
    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    patterns = load_distillation_patterns(path)
    assert patterns, "No patterns found to begin matching."

    url = f"{ACME_HOSTNAME}{location}"
    browser = await create_remote_browser(browser_id=generate(FRIENDLY_CHARS, 6))
    try:
        page = await get_new_page(browser)
        hostname = urllib.parse.urlparse(url).hostname
        await page.get(url)
        await page.wait(3)

        match = await distill(hostname, page, patterns)
        assert match, "No match found when one was expected."
        assert match.name.endswith(DISTILL_PATTERN_LOCATIONS[location]), (
            "Incorrect match name found."
        )
    finally:
        await terminate_remote_browser(browser)


@pytest.mark.asyncio
@pytest.mark.distill
@pytest.mark.parametrize("location", SIGN_IN_PATTERN_ENDPOINTS)
async def test_distillation_loop(location: str):
    """Tests distillation loop with email and password autofill."""
    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    patterns = load_distillation_patterns(path)
    assert patterns, "No patterns found to begin matching."

    browser = await create_remote_browser(browser_id=generate(FRIENDLY_CHARS, 6))
    try:
        _terminated, distilled, converted = await run_distillation_loop(
            location=f"{ACME_HOSTNAME}{location}",
            patterns=patterns,
            browser=browser,
            timeout=30,
        )
        result = converted if converted else distilled
        assert result, "No result found when one was expected."
    finally:
        await terminate_remote_browser(browser)


# Map error endpoints to expected pattern names (production patterns)
BROWSER_ERROR_ENDPOINTS = {
    "/error/timed-out": "err-timed-out.html",
    "/error/ssl-protocol-error": "err-ssl-protocol-error.html",
    "/error/tunnel-connection-failed": "err-tunnel-connection-failed.html",
    "/error/proxy-connection-failed": "err-proxy-connection-failed.html",
}


class StubPage:
    def __init__(self, result: object):
        self.result = result
        self.calls: list[str] = []

    async def evaluate(self, js_code: str):
        self.calls.append(js_code)
        return self.result


@pytest.mark.asyncio
async def test_page_batch_extract_returns_result_map():
    page = StubPage({
        "0": {
            "found": True,
            "tag": "h1",
            "text": "Welcome",
        },
        "1": {
            "found": True,
            "tag": "section",
            "html": "<p>Account</p>",
        },
    })

    result = await page_batch_extract(
        cast(Any, page),
        [
            {
                "query_key": "0",
                "selector": "h1",
                "iframe_selector": None,
                "wants_html": False,
                "wants_text": True,
                "wants_value": True,
            },
            {
                "query_key": "1",
                "selector": "//section[@data-role='account']",
                "iframe_selector": None,
                "wants_html": True,
                "wants_text": False,
                "wants_value": False,
            },
        ],
    )

    assert result == {
        "0": {
            "found": True,
            "tag": "h1",
            "text": "Welcome",
        },
        "1": {
            "found": True,
            "tag": "section",
            "html": "<p>Account</p>",
        },
    }
    assert len(page.calls) == 1


@pytest.mark.asyncio
async def test_page_batch_extract_returns_empty_mapping_for_no_queries():
    page = StubPage({"0": {"found": True}})

    result = await page_batch_extract(cast(Any, page), [])

    assert result == {}
    assert len(page.calls) == 0


@pytest.mark.asyncio
async def test_page_batch_extract_falls_back_to_none_on_invalid_result():
    page = StubPage(["invalid"])

    result = await page_batch_extract(
        cast(Any, page),
        [{"query_key": "0", "selector": "h1", "wants_html": False, "wants_text": True}],
    )

    assert result is None
    assert len(page.calls) == 1


@pytest.mark.asyncio
async def test_distill_uses_page_batch_extract(monkeypatch: MonkeyPatch):
    async def stub_page_batch_extract(
        page: Any, queries: list[dict[str, object]]
    ) -> dict[str, dict[str, object]]:
        assert queries == [
            {
                "query_key": "0",
                "selector": "button.login",
                "iframe_selector": None,
                "wants_html": False,
                "wants_text": True,
                "wants_value": True,
            },
            {
                "query_key": "1",
                "selector": "input[name='email']",
                "iframe_selector": "iframe.auth",
                "wants_html": False,
                "wants_text": True,
                "wants_value": True,
            },
            {
                "query_key": "2",
                "selector": "//section[@data-role='content']",
                "iframe_selector": None,
                "wants_html": True,
                "wants_text": False,
                "wants_value": False,
            },
        ]
        return {
            "0": {
                "found": True,
                "tag": "button",
                "text": "Sign in",
            },
            "1": {
                "found": True,
                "tag": "input",
                "text": "",
                "value": "person@example.com",
            },
            "2": {
                "found": True,
                "tag": "section",
                "html": "<p>Account details</p>",
            },
        }

    monkeypatch.setattr("getgather.zen_distill.page_batch_extract", stub_page_batch_extract)

    pattern = Pattern(
        name="batched-login.html",
        pattern=BeautifulSoup(
            """
            <html gg-priority="1">
                <button rb-match="button.login"></button>
                <div rb-match-html="//section[@data-role='content']"></div>
                <input rb-match="iframe.auth input[name='email']" />
            </html>
            """,
            "html.parser",
        ),
    )

    match = await distill("example.com", cast(Any, object()), [pattern], reload_on_error=False)

    assert match is not None
    assert "Sign in" in match.distilled
    assert "<p>Account details</p>" in match.distilled
    assert 'value="person@example.com"' in match.distilled


@pytest.mark.asyncio
async def test_distill_rejects_pattern_when_required_batched_target_missing(
    monkeypatch: MonkeyPatch,
):
    async def stub_page_batch_extract(
        page: Any, queries: list[dict[str, object]]
    ) -> dict[str, dict[str, object]]:
        assert queries == [
            {
                "query_key": "0",
                "selector": "button.login",
                "iframe_selector": None,
                "wants_html": False,
                "wants_text": True,
                "wants_value": True,
            }
        ]
        return {
            "0": {
                "found": False,
            }
        }

    monkeypatch.setattr("getgather.zen_distill.page_batch_extract", stub_page_batch_extract)

    pattern = Pattern(
        name="required-login.html",
        pattern=BeautifulSoup(
            '<html gg-priority="1"><button rb-match="button.login"></button></html>',
            "html.parser",
        ),
    )

    match = await distill("example.com", cast(Any, object()), [pattern], reload_on_error=False)

    assert match is None


@pytest.mark.asyncio
async def test_distill_allows_optional_batched_target_to_be_missing(monkeypatch: MonkeyPatch):
    async def stub_page_batch_extract(
        page: Any, queries: list[dict[str, object]]
    ) -> dict[str, dict[str, object]]:
        assert queries == [
            {
                "query_key": "0",
                "selector": "button.login",
                "iframe_selector": None,
                "wants_html": False,
                "wants_text": True,
                "wants_value": True,
            },
            {
                "query_key": "1",
                "selector": ".helper",
                "iframe_selector": None,
                "wants_html": False,
                "wants_text": True,
                "wants_value": True,
            },
        ]
        return {
            "0": {
                "found": True,
                "tag": "button",
                "text": "Sign in",
            },
            "1": {
                "found": False,
            },
        }

    monkeypatch.setattr("getgather.zen_distill.page_batch_extract", stub_page_batch_extract)

    pattern = Pattern(
        name="optional-helper.html",
        pattern=BeautifulSoup(
            """
            <html gg-priority="1">
                <button rb-match="button.login"></button>
                <span rb-match=".helper" gg-optional></span>
            </html>
            """,
            "html.parser",
        ),
    )

    match = await distill("example.com", cast(Any, object()), [pattern], reload_on_error=False)

    assert match is not None
    assert "Sign in" in match.distilled


@pytest.mark.asyncio
@pytest.mark.distill
async def test_distillation_captures_screenshot_without_pattern(
    tmp_path: Path, monkeypatch: MonkeyPatch
):
    """Navigates to a page without patterns and verifies a screenshot is saved."""

    monkeypatch.setattr(cast(Any, settings), "DATA_DIR", str(tmp_path), raising=False)

    screenshot_dir: Path = settings.screenshots_dir
    before = set(screenshot_dir.glob("*.png"))

    path = os.path.join(os.path.dirname(__file__), "patterns", "**/*.html")
    patterns = load_distillation_patterns(path)
    assert patterns, "No patterns found to begin matching."

    browser = await create_remote_browser(browser_id=generate(FRIENDLY_CHARS, 6))
    try:
        terminated, _distilled, _converted = await run_distillation_loop(
            location=f"{ACME_HOSTNAME}/random-info-page",
            patterns=patterns,
            browser=browser,
            timeout=2,
            error_reporter=make_error_reporter(browser, f"{ACME_HOSTNAME}/random-info-page"),
        )

        assert not terminated, "Expected not to terminate when no pattern matches."

        after = set(screenshot_dir.glob("*.png"))
        new_files = [item for item in after if item not in before]
        assert new_files, "Expected a distillation screenshot to be captured."
        assert all(file.stat().st_size > 0 for file in new_files)
    finally:
        await terminate_remote_browser(browser)


@pytest.mark.asyncio
@pytest.mark.distill
@pytest.mark.parametrize("location", list(BROWSER_ERROR_ENDPOINTS.keys()))
async def test_browser_error_patterns(location: str):
    """
    Tests for browser error page pattern matching.

    Tests that error patterns (ERR_TIMED_OUT, ERR_SSL_PROTOCOL_ERROR, etc.)
    are correctly matched.

    These tests use the production patterns from getgather/mcp/patterns/err-*.html
    to ensure the actual patterns work correctly.
    """
    path = str(PROJECT_ROOT / "getgather" / "mcp" / "patterns" / "err-*.html")
    patterns = load_distillation_patterns(path)
    assert patterns, "No patterns found"

    url = f"{ACME_HOSTNAME}{location}"
    browser = await create_remote_browser(browser_id=generate(FRIENDLY_CHARS, 6))
    try:
        page = await get_new_page(browser)
        hostname = urllib.parse.urlparse(url).hostname

        await page.get(url)
        await page.wait(1)

        match = await distill(hostname, page, patterns, reload_on_error=False)
        assert match, f"No match found for {url}"
        assert match.name.endswith(BROWSER_ERROR_ENDPOINTS[location]), (
            f"Expected pattern {BROWSER_ERROR_ENDPOINTS[location]}, got {match.name}"
        )
    finally:
        await terminate_remote_browser(browser)
