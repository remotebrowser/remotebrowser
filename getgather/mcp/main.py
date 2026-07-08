from dataclasses import dataclass
from functools import cache, cached_property
from typing import Any, Literal

from fastmcp import Context, FastMCP
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.http import StarletteWithLifespan
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from loguru import logger
from pydantic import BaseModel

import getgather.mcp.declarative_mcp  # noqa: F401  # pyright: ignore[reportUnusedImport]
from getgather.mcp.dpage import (
    dpage_check,
    dpage_finalize,
    remote_zen_dpage_mcp_tool,
)
from getgather.mcp.registry import MCPTool


class LocationProxyMiddleware(Middleware):
    # type: ignore
    async def on_call_tool(self, context: MiddlewareContext[Any], call_next: CallNext[Any, Any]):
        if not context.fastmcp_context:
            return await call_next(context)

        headers = get_http_headers(include_all=True)

        # Build logging context with session IDs
        log_context = {}
        mcp_session_id = headers.get("mcp-session-id")
        browser_session_id = headers.get("x-browser-session-id")

        if mcp_session_id:
            log_context["mcp_session_id"] = mcp_session_id
        if browser_session_id:
            log_context["browser_session_id"] = browser_session_id

        tool = await context.fastmcp_context.fastmcp.get_tool(context.message.name)  # type: ignore

        if "general_tool" in tool.tags:  # pyright: ignore[reportOptionalMemberAccess]
            with logger.contextualize(**log_context):
                return await call_next(context)

        brand_id = context.message.name.split("_")[0]
        await context.fastmcp_context.set_state("brand_id", brand_id)

        # Use contextualize to set context for all logs during tool execution
        with logger.contextualize(**log_context):
            logger.info(f"[AuthMiddleware Context]: {context.message}")
            return await call_next(context)


MCP_BUNDLES: dict[str, list[str]] = {
    "media": ["bbc"],
    "books": ["goodreads"],
    "shopping": ["amazon", "amazonca", "shopee", "wayfair", "kroger", "target"],
    "sports": ["garmin"],
    "food": ["doordash"],
}


@dataclass
class MCPApp:
    name: str
    type: Literal["brand", "category", "all"]
    route: str
    brand_ids: list[str]

    @cached_property
    def app(self) -> StarletteWithLifespan:
        return _create_mcp_app(self.name, self.brand_ids)


@cache
def create_mcp_apps() -> list[MCPApp]:
    apps: list[MCPApp] = []
    apps.append(
        MCPApp(
            name="all",
            type="all",
            route="/mcp",
            brand_ids=list(MCPTool.registry.keys()),
        )
    )
    # Add individual brand MCPs from MCPTool registry
    apps.extend([
        MCPApp(
            name=brand_id,
            type="brand",
            route=f"/mcp-{brand_id}",
            brand_ids=[brand_id],
        )
        for brand_id in MCPTool.registry.keys()
    ])
    apps.extend([
        MCPApp(
            name=category,
            type="category",
            route=f"/mcp-{category}",
            brand_ids=MCP_BUNDLES[category],
        )
        for category in MCP_BUNDLES.keys()
    ])
    return apps


def _create_mcp_app(bundle_name: str, brand_ids: list[str]):
    """Create and return the MCP ASGI app.

    This performs plugin discovery/registration and mounts brand MCPs.
    """
    mcp = FastMCP[Context](name=f"Getgather {bundle_name} MCP")
    mcp.add_middleware(LocationProxyMiddleware())

    @mcp.tool(tags={"general_tool"})
    async def check_signin(ctx: Context, signin_id: str) -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        result = await dpage_check(id=signin_id)
        if result is None:
            return {
                "status": "ERROR",
                "message": "Sign in not completed within the time limit. Please try again.",
                "completed": False,
            }
        return {
            "status": "SUCCESS",
            "message": "Sign in completed successfully. Call the same MCP tool again to fetch data.",
            "completed": True,
        }

    @mcp.tool(tags={"general_tool"})
    async def finalize_signin(ctx: Context, signin_id: str) -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        await dpage_finalize(id=signin_id)
        return {
            "status": "SUCCESS",
            "message": "Sign in finalized successfully.",
        }

    @mcp.tool(tags={"general_tool"})
    async def get_browser_ip_address() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        return await _get_browser_ip_address()

    @mcp.tool(tags={"general_tool"})
    async def get_zen_browser_ip_address() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        return await _get_browser_ip_address()

    async def _get_browser_ip_address() -> dict[str, Any]:
        return await remote_zen_dpage_mcp_tool(
            initial_url="https://ip.fly.dev/ip", result_key="ip_address"
        )

    for brand_id in brand_ids:
        brand_id_str = brand_id
        if brand_id_str in MCPTool.registry:
            gather_mcp = MCPTool.registry[brand_id_str]
            logger.info(
                f"Mounting {gather_mcp.name} (distillation-based) to MCP bundle {bundle_name}"
            )
            mcp.mount(server=gather_mcp, namespace=gather_mcp.brand_id)

    return mcp.http_app(path="/", stateless_http=True)


class MCPToolDoc(BaseModel):
    name: str
    description: str


class MCPDoc(BaseModel):
    name: str
    type: Literal["brand", "category", "all"]
    route: str
    tools: list[MCPToolDoc]


async def mcp_app_docs(mcp_app: MCPApp) -> MCPDoc:
    return MCPDoc(
        name=mcp_app.name,
        type=mcp_app.type,
        route=mcp_app.route,
        tools=[
            MCPToolDoc(
                name=tool.name,
                description=tool.description or "No description provided",
            )
            for tool in await mcp_app.app.state.fastmcp_server.list_tools()
        ],
    )
