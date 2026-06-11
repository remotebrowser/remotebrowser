import asyncio
import json
from dataclasses import dataclass
from functools import cache, cached_property
from typing import Any, Literal, cast

import mcp.types
from fastmcp import Context, FastMCP
from fastmcp.resources.resource import ResourceResult
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.http import StarletteWithLifespan
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from loguru import logger
from pydantic import BaseModel

from getgather.auth.auth import get_auth_user
from getgather.config import settings
from getgather.mcp.auto_import import auto_import
from getgather.mcp.browser import browser_manager, terminate_zendriver_browser
from getgather.mcp.dpage import (
    dpage_check,
    dpage_finalize,
    zen_dpage_mcp_tool,
)
from getgather.mcp.registry import GatherMCP
from getgather.mcp.ui import UI_MIME_TYPE, ui_to_meta_dict
from getgather.request_info import RequestInfo, request_info


def _inject_app_ui_content_meta(
    fastmcp_server: FastMCP,
    uri_to_meta: dict[str, dict[str, Any]],
) -> None:
    """Wrap read_resource handler so content items include _meta.ui (e.g. csp) for app UI resources."""
    mcp_server = getattr(fastmcp_server, "_mcp_server", None)
    if mcp_server is None:
        return
    original = mcp_server.request_handlers.get(mcp.types.ReadResourceRequest)
    if original is None:
        return

    async def wrapped(req: mcp.types.ReadResourceRequest) -> mcp.types.ServerResult:
        result = await original(req)
        uri = str(req.params.uri)
        meta = uri_to_meta.get(uri)
        result_root = getattr(result, "root", None)
        if meta is None or result_root is None:
            return result
        contents: list[mcp.types.TextResourceContents | mcp.types.BlobResourceContents] = (
            getattr(result_root, "contents", None) or []
        )
        if not contents:
            return result
        new_contents: list[mcp.types.TextResourceContents | mcp.types.BlobResourceContents] = []
        for c in contents:
            existing_meta: dict[str, Any] = getattr(c, "_meta", None) or {}
            content_meta: dict[str, Any] = {**existing_meta, **meta}
            if isinstance(c, mcp.types.TextResourceContents):
                new_contents.append(
                    mcp.types.TextResourceContents(
                        uri=c.uri,
                        mimeType=c.mimeType,
                        text=c.text,
                        _meta=content_meta,
                    )
                )
            elif isinstance(c, mcp.types.BlobResourceContents):  # pyright: ignore[reportUnnecessaryIsInstance]
                new_contents.append(
                    mcp.types.BlobResourceContents(
                        uri=c.uri,
                        mimeType=c.mimeType,
                        blob=c.blob,
                        _meta=content_meta,
                    )
                )
            else:
                new_contents.append(cast(mcp.types.TextResourceContents, c))
        return mcp.types.ServerResult(mcp.types.ReadResourceResult(contents=new_contents))

    mcp_server.request_handlers[mcp.types.ReadResourceRequest] = wrapped


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

        signin_id = headers.get("x-signin-id") or None

        # Initialize request_info data
        info_data: dict[str, str | None] = {}

        # Handle x-location header (contains city, state, country, postal_code)
        location = headers.get("x-location", None)
        if location is not None:
            try:
                location_data: dict[str, str | None] = json.loads(location)
                info_data.update(location_data)
            except json.JSONDecodeError:
                with logger.contextualize(**log_context):
                    logger.warning(f"Failed to parse x-location header as JSON, {location}")

        # Handle x-proxy-type header (e.g., "proxy-0", "proxy-1", etc.)
        proxy_type = headers.get("x-proxy-type", None)
        if proxy_type is not None:
            info_data["proxy_type"] = proxy_type

        # Set request_info if we have any data
        if info_data:
            request_info.set(RequestInfo(**info_data))  # type: ignore[arg-type]

        tool = await context.fastmcp_context.fastmcp.get_tool(context.message.name)  # type: ignore

        if "general_tool" in tool.tags:  # pyright: ignore[reportOptionalMemberAccess]
            with logger.contextualize(**log_context):
                return await self._call_next_with_timeout(context, call_next, signin_id)

        brand_id = context.message.name.split("_")[0]
        await context.fastmcp_context.set_state("brand_id", brand_id)

        # Use contextualize to set context for all logs during tool execution
        with logger.contextualize(**log_context):
            logger.info(f"[AuthMiddleware Context]: {context.message}")
            if proxy_type:
                logger.info(f"Received x-proxy-type header: {proxy_type}")
            return await self._call_next_with_timeout(context, call_next, signin_id)

    async def _call_next_with_timeout(
        self,
        context: MiddlewareContext[Any],
        call_next: CallNext[Any, Any],
        signin_id: str | None,
    ) -> Any:
        """Run the tool with an overall deadline.

        A stuck tool call (e.g. a hung page navigation) must not be able to run
        indefinitely and pin its browser. On timeout we release the session
        browser and surface the failure to the client instead of hanging.
        """
        timeout = settings.MCP_TOOL_CALL_TIMEOUT
        try:
            async with asyncio.timeout(timeout):
                return await call_next(context)
        except TimeoutError:
            logger.error(
                f"Tool call '{context.message.name}' exceeded {timeout}s timeout; "
                f"aborting and releasing browser"
            )
            await self._release_session_browser(signin_id)
            raise TimeoutError(
                f"Tool call '{context.message.name}' timed out after {timeout}s"
            ) from None

    @staticmethod
    async def _release_session_browser(signin_id: str | None) -> None:
        """Terminate the browser tied to a signin session after a timeout.

        Only incognito (per-session) browsers are released; the shared global
        browser is left untouched. Bounded by its own timeout so a stuck
        teardown cannot hang the request that is already timing out.
        """
        if not signin_id or not browser_manager.has_incognito_browser(signin_id):
            return
        browser = browser_manager.get_incognito_browser(signin_id)
        try:
            if browser is not None:
                async with asyncio.timeout(30):
                    await terminate_zendriver_browser(browser)
                logger.info(f"Released browser for signin_id {signin_id} after tool timeout")
        except Exception as e:
            logger.error(f"Failed to release browser for signin_id {signin_id} after timeout: {e}")
        finally:
            browser_manager.remove_incognito_browser(signin_id)


MCP_BUNDLES: dict[str, list[str]] = {
    "media": ["bbc", "cnn", "espn", "groundnews", "npr", "nytimes"],
    "books": ["goodreads"],
    "shopping": ["amazon", "amazonca", "shopee", "wayfair"],
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
    from getgather.mcp.declarative_mcp import create_declarative_mcp_tools

    create_declarative_mcp_tools()
    auto_import("getgather.mcp")

    apps: list[MCPApp] = []
    apps.append(
        MCPApp(
            name="all",
            type="all",
            route="/mcp",
            brand_ids=list(GatherMCP.registry.keys()),
        )
    )
    # Add individual brand MCPs from GatherMCP registry
    apps.extend([
        MCPApp(
            name=brand_id,
            type="brand",
            route=f"/mcp-{brand_id}",
            brand_ids=[brand_id],
        )
        for brand_id in GatherMCP.registry.keys()
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
    def get_user_info():  # type: ignore[reportUnusedFunction]
        """Get information about the authenticated user."""
        user = get_auth_user()
        return user.dump()

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
        return await zen_dpage_mcp_tool(
            initial_url="https://ip.fly.dev/ip", result_key="ip_address"
        )

    app_ui_content_meta: dict[str, dict[str, Any]] = {}

    for brand_id in brand_ids:
        brand_id_str = brand_id
        if brand_id_str in GatherMCP.registry:
            gather_mcp = GatherMCP.registry[brand_id_str]
            logger.info(
                f"Mounting {gather_mcp.name} (distillation-based) to MCP bundle {bundle_name}"
            )
            if gather_mcp.app_ui:
                app_ui = gather_mcp.app_ui
                resource_uri = app_ui.resource_uri
                if resource_uri is None:
                    logger.warning(f"MCP App UI for {brand_id_str} has no resource_uri")
                    continue

                logger.info(f"MCP App UI enabled for {brand_id_str}: {resource_uri}")
                app_ui_content_meta[str(resource_uri)] = {"ui": ui_to_meta_dict(app_ui)}

                def _make_ui_resource(server: GatherMCP, ui_uri: str):
                    async def _read() -> str | bytes | ResourceResult:
                        resource = await server.get_resource(ui_uri)
                        return await resource.read()  # pyright: ignore[reportOptionalMemberAccess]

                    return _read

                mcp.resource(
                    uri=resource_uri,
                    mime_type=UI_MIME_TYPE,
                    meta={"ui": ui_to_meta_dict(app_ui)},
                )(_make_ui_resource(gather_mcp, resource_uri))
                logger.info(
                    f"MCP App UI for {brand_id_str} uses dynamic resource, registered on parent"
                )
            mcp.mount(server=gather_mcp, namespace=gather_mcp.brand_id)

    if app_ui_content_meta:
        _inject_app_ui_content_meta(mcp, app_ui_content_meta)

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
