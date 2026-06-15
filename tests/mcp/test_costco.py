"""Integration test for Costco auth flow."""

import json
import os
from typing import Any

import pytest
import zendriver as zd
from fastmcp import Client
from mcp.types import TextContent


@pytest.mark.mcp
@pytest.mark.asyncio
async def test_costco_auth_flow(mcp_config: dict[str, Any]):
    """Verify Costco sign-in returns a signin URL and completes auth."""
    client = Client(mcp_config, timeout=120)
    async with client:
        result = await client.call_tool("costco_get_orders")
        assert isinstance(result.content[0], TextContent)
        parsed = json.loads(result.content[0].text)
        assert parsed.get("url"), "Expected signin URL"
        assert parsed.get("signin_id"), "Expected signin_id"

        signin_url = parsed["url"]
        signin_id = parsed["signin_id"]

        browser = await zd.start(no_sandbox=True, headless=True)
        try:
            page = await browser.get(signin_url)

            email_input = await page.wait_for("input#signInName", timeout=30)
            await email_input.send_keys(os.environ.get("COSTCO_EMAIL", ""))

            password_input = await page.wait_for("input#password", timeout=10)
            await password_input.send_keys(os.environ.get("COSTCO_PASSWORD", ""))

            submit_btn = await page.wait_for("button#next:not([disabled])", timeout=10)
            await submit_btn.click()

            await page.wait_for(text="Finished!", timeout=60)
        finally:
            await browser.stop()

        check = await client.call_tool("check_signin", {"signin_id": signin_id})
        assert isinstance(check.content[0], TextContent)
        check_result = json.loads(check.content[0].text)
        assert check_result.get("status") == "SUCCESS"
        assert check_result.get("completed") is True
