"""Tests for Target Tools: login, get_purchases_online."""

import json
import os
from typing import Any

import pytest
import zendriver as zd
from fastmcp import Client
from mcp.types import TextContent


@pytest.mark.mcp
@pytest.mark.asyncio
@pytest.mark.xfail(reason="flaky")
async def test_target_login_and_get_purchases_online(mcp_config: dict[str, Any]) -> None:
    """Test login to Target and get online purchase history."""
    client = Client(mcp_config, timeout=120)
    async with client:
        mcp_call_tool = await client.call_tool("target_get_purchases_online")
        assert isinstance(mcp_call_tool.content[0], TextContent), (
            f"Expected TextContent, got {type(mcp_call_tool.content[0])}"
        )
        mcp_call_signin_result = json.loads(mcp_call_tool.content[0].text)
        assert mcp_call_signin_result.get("url")
        assert mcp_call_signin_result.get("signin_id")
        print(mcp_call_signin_result.get("url"))

        browser = await zd.start(no_sandbox=True, headless=True)
        try:
            page = await browser.get(mcp_call_signin_result.get("url"))

            # Target multi-step signin: email → choose method → password
            email_input = await page.wait_for("input#username", timeout=15)
            await email_input.send_keys(os.environ.get("TARGET_EMAIL", ""))
            submit_btn = await page.select("button#login")
            await submit_btn.click()

            # "Choose method" screen appears for some accounts
            try:
                password_btn = await page.wait_for("div#password[role='button']", timeout=5)
                await password_btn.click()
            except Exception:
                pass

            password_input = await page.wait_for("input[data-test='login-password']", timeout=15)
            await password_input.send_keys(os.environ.get("TARGET_PASSWORD", ""))
            signin_btn = await page.wait_for(
                "//button[@type='submit' and contains(normalize-space(.), 'Sign in with password')]",
                timeout=5,
            )
            await signin_btn.click()

            await page.wait_for(text="Finished!", timeout=60)

            mcp_call_check_signin = await client.call_tool(
                "check_signin", {"signin_id": mcp_call_signin_result.get("signin_id")}
            )
            assert isinstance(mcp_call_check_signin.content[0], TextContent)
            mcp_call_check_signin_result = json.loads(mcp_call_check_signin.content[0].text)
            assert mcp_call_check_signin_result.get("status") == "SUCCESS"
            assert mcp_call_check_signin_result.get("completed") is True
            assert "result" not in mcp_call_check_signin_result

            mcp_call_get_purchases = await client.call_tool("target_get_purchases_online")
            assert isinstance(mcp_call_get_purchases.content[0], TextContent)
            parsed = json.loads(mcp_call_get_purchases.content[0].text)
            purchases = parsed.get("target_purchases")
            print(purchases)
            assert purchases is not None, "Expected 'target_purchases' key in response"
            assert isinstance(purchases, list), f"Expected list, got {type(purchases)}"
        finally:
            await browser.stop()
