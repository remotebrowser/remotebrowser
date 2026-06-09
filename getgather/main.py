import ast
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime
from typing import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import (
    HTMLResponse,
    PlainTextResponse,
    Response,
)
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from loguru import logger

from getgather.auth.auth import setup_mcp_auth
from getgather.browsers.router import backend, router as browsers_router
from getgather.config import PROJECT_DIR, settings
from getgather.logs import MCPLoggingContextMiddleware
from getgather.mcp.dpage import remote_zen_dpage_mcp_tool, router as dpage_router
from getgather.mcp.main import MCPDoc, create_mcp_apps, mcp_app_docs
from getgather.tracing import MCPSessionTraceMiddleware, instrument_fastapi

# Create MCP apps once and reuse for lifespan and mounting
mcp_apps = create_mcp_apps()


def custom_generate_unique_id(route: APIRoute) -> str:
    tag = route.tags[0] if route.tags else "no-tag"
    return f"{tag}-{route.name}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.CHROMEFLEET_URL:
        logger.warning("CHROMEFLEET_URL is not set, falling back to local browsers")

    stop_event = asyncio.Event()

    async def timer_loop():
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=5 * 60)
            except asyncio.TimeoutError:
                pass

    background_task = asyncio.create_task(timer_loop())

    try:
        async with AsyncExitStack() as stack:
            for mcp_app in mcp_apps:
                await stack.enter_async_context(mcp_app.app.lifespan(app))
            yield

            stop_event.set()
            await background_task
    finally:
        await backend.shutdown()


app = FastAPI(
    title="Get Gather",
    description="GetGather mcp, frontend, and api",
    version="0.1.1",
    generate_unique_id_function=custom_generate_unique_id,
    lifespan=lifespan,
)
app.add_middleware(MCPLoggingContextMiddleware)
instrument_fastapi(app)


@app.get("/health")
def health():
    return PlainTextResponse(
        content=f"OK {int(datetime.now().timestamp())} GIT_REV: {settings.GIT_REV}"
    )


@app.get("/extended-health")
async def extended_health():
    try:
        result = await remote_zen_dpage_mcp_tool(
            initial_url="https://ip.fly.dev/ip", result_key="ip_address", timeout=3
        )
        ip_text = str(result.get("ip_address", "Unknown"))[:100]
        ip_list = ast.literal_eval(ip_text)
        ip_address = ip_list[0]["ip_address"]
        logger.debug(f"IP address: {ip_address}")
        return PlainTextResponse(content=f"OK IP: {ip_address}")
    except Exception as e:
        return PlainTextResponse(content=f"Error: {e}")


@app.middleware("http")
async def mcp_slash_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
):
    # Make /mcp* and /mcp*/ behave the same without an actual redirect.
    path = request.url.path
    if path.startswith("/mcp") and not path.endswith("/"):
        request.scope["path"] = f"{path}/"
        if request.scope.get("raw_path"):
            request.scope["raw_path"] = f"{path}/".encode()
    return await call_next(request)


# Mount routers and apps AFTER middleware
app.include_router(browsers_router)
app.include_router(dpage_router)

for mcp_app in mcp_apps:
    app.mount(mcp_app.route, mcp_app.app)

setup_mcp_auth(app, [mcp_app.route for mcp_app in mcp_apps])


@app.get("/docs-mcp")
async def mcp_docs() -> list[MCPDoc]:
    return await asyncio.gather(*[mcp_app_docs(mcp_app) for mcp_app in create_mcp_apps()])


if settings.CHROMEFLEET_URL:

    @app.get("/")
    def homepage():
        html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GetGather</title>
<style>html,body{{margin:0;padding:0;height:100%;overflow:hidden}}iframe{{border:none;width:100%;height:100%}}</style>
</head>
<body><iframe src="{settings.CHROMEFLEET_URL}"></iframe></body>
</html>"""
        return HTMLResponse(content=html)

else:
    app.mount(
        "/",
        StaticFiles(directory=str(PROJECT_DIR / "getgather" / "webui"), html=True),
        name="webui",
    )


# Wrap the entire instrumented app so mcp-session-id handling runs BEFORE
# OTel's FastAPI instrumentation. When the caller has its own trace context,
# we leave it alone; otherwise we parent the request under a session trace.
app = MCPSessionTraceMiddleware(app)  # type: ignore[assignment]
