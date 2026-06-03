import ast
import asyncio
import json
import socket
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Final

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from loguru import logger

from getgather.auth.auth import setup_mcp_auth
from getgather.config import settings
from getgather.logs import instrument_fastapi
from getgather.mcp.browser import browser_manager
from getgather.mcp.dpage import remote_zen_dpage_mcp_tool, router as dpage_router
from getgather.mcp.main import MCPDoc, create_mcp_apps, mcp_app_docs

# Create MCP apps once and reuse for lifespan and mounting
mcp_apps = create_mcp_apps()


def custom_generate_unique_id(route: APIRoute) -> str:
    tag = route.tags[0] if route.tags else "no-tag"
    return f"{tag}-{route.name}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.CHROMEFLEET_URL:
        logger.error("CHROMEFLEET_URL is not set. Exiting.")
        raise SystemExit(1)

    stop_event = asyncio.Event()

    async def timer_loop():
        while not stop_event.is_set():
            try:
                await browser_manager.cleanup_incognito_browsers()
            except Exception as e:
                logger.error(f"Error in cleanup_incognito_browsers: {e}", exc_info=True)
            try:
                # Run in a thread: rmtree of large profile dirs can block for seconds
                await asyncio.to_thread(browser_manager.cleanup_orphaned_profiles)
            except Exception as e:
                logger.error(f"Error in cleanup_orphaned_profiles: {e}", exc_info=True)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=5 * 60)
            except asyncio.TimeoutError:
                pass  # Timeout = 5 minutes passed, continue loop

    background_task = asyncio.create_task(timer_loop())

    async with AsyncExitStack() as stack:
        for mcp_app in mcp_apps:
            await stack.enter_async_context(mcp_app.app.lifespan(app))
        yield

        stop_event.set()
        await background_task


app = FastAPI(
    title="Get Gather",
    description="GetGather mcp, frontend, and api",
    version="0.1.0",
    generate_unique_id_function=custom_generate_unique_id,
    lifespan=lifespan,
)
instrument_fastapi(app)

STATIC_DIR = Path(__file__).parent / "static"
STATIC_ASSETS_DIR = STATIC_DIR / "assets"
FRONTEND_DIR = Path(__file__).parent / "frontend"


app.mount("/__static/assets", StaticFiles(directory=STATIC_ASSETS_DIR), name="assets")


@app.get("/live")
def read_live():
    return RedirectResponse(url="/live/", status_code=301)


@app.get("/live/{file_path:path}")
async def proxy_live_files(file_path: str):
    # noVNC lite's main web UI
    if file_path == "" or file_path == "old-index.html":
        local_file_path = FRONTEND_DIR / "live.html"
        with open(local_file_path) as f:
            return HTMLResponse(content=f.read())

    # Proxy noVNC libraries to unpkg.com
    unpkg_url = f"https://unpkg.com/@novnc/novnc@1.3.0/{file_path}"

    logger.info(f"Proxying {file_path} to {unpkg_url}")

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(unpkg_url)
            content = response.content
            logger.debug(f"Response's length: {len(content)}")

            # Filter out headers that can cause decoding issues
            headers = dict(response.headers)
            for header in ["content-encoding", "content-length", "transfer-encoding"]:
                headers.pop(header, None)

            return Response(status_code=response.status_code, content=content, headers=headers)
        except httpx.RequestError:
            return Response(status_code=404)


@app.websocket("/websockify")
async def vnc_websocket_proxy(websocket: WebSocket):
    """WebSocket proxy to bridge NoVNC client and VNC server."""
    await websocket.accept()

    vnc_socket = None
    websocket_closed = asyncio.Event()

    try:
        vnc_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        vnc_socket.connect(("localhost", 5900))
        vnc_socket.setblocking(False)

        async def forward_to_vnc():
            try:
                while not websocket_closed.is_set():
                    data = await websocket.receive_bytes()
                    vnc_socket.send(data)
            except WebSocketDisconnect:
                websocket_closed.set()
            except Exception as e:
                logger.error(f"Error forwarding to VNC: {e}")
                websocket_closed.set()

        async def forward_from_vnc():
            try:
                while not websocket_closed.is_set():
                    await asyncio.sleep(0.001)
                    try:
                        data = vnc_socket.recv(4096)
                        if data:
                            if not websocket_closed.is_set():
                                await websocket.send_bytes(data)
                        else:
                            break  # VNC connection closed
                    except socket.error:
                        continue
            except Exception as e:
                logger.error(f"Error forwarding from VNC: {e}")
            finally:
                websocket_closed.set()

        await asyncio.gather(forward_to_vnc(), forward_from_vnc(), return_exceptions=True)

    except ConnectionRefusedError:
        if not websocket_closed.is_set():
            try:
                await websocket.send_text("Error: Could not connect to VNC server on port 5900")
            except:
                pass
    except Exception as e:
        if not websocket_closed.is_set():
            try:
                await websocket.send_text(f"Error: {str(e)}")
            except:
                pass
    finally:
        websocket_closed.set()
        try:
            if vnc_socket is not None:
                vnc_socket.close()
        except:
            pass
        try:
            if websocket.client_state.value <= 2:  # CONNECTING or CONNECTED
                await websocket.close()
        except:
            pass


@app.get("/health")
def health():
    return PlainTextResponse(
        content=f"OK {int(datetime.now().timestamp())} GIT_REV: {settings.GIT_REV}"
    )


IP_CHECK_URL: Final[str] = "https://ip.fly.dev/ip"


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
async def mcp_logging_context_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
):
    """Set logging context with session IDs for MCP requests."""
    if request.url.path.startswith("/mcp"):
        # Extract session IDs from headers
        browser_session_id = request.headers.get("x-browser-session-id")
        mcp_session_id = request.headers.get("mcp-session-id")

        # Build context dict
        context = {}
        if browser_session_id:
            context["browser_session_id"] = browser_session_id
            request.state.browser_session_id = browser_session_id
        if mcp_session_id:
            context["mcp_session_id"] = mcp_session_id
            request.state.mcp_session_id = mcp_session_id

        # Try to extract signin_id from request body if POST
        if request.method == "POST":
            try:
                body = await request.body()
                if body:
                    body_json: Any = json.loads(body.decode("utf-8"))
                    if isinstance(body_json, dict):
                        params: Any = body_json.get("params", {})  # type: ignore[misc]
                        if isinstance(params, dict):  # type: ignore[arg-type]
                            signin_id: Any = params.get("signin_id")  # type: ignore[misc]
                            if signin_id:  # type: ignore[arg-type]
                                context["signin_id"] = signin_id
            except Exception:
                pass

        # Use contextualize to set context for all logs in this request
        with logger.contextualize(**context):
            logger.info(f"[MIDDLEWARE] Processing MCP request to {request.url.path}")
            response = await call_next(request)

            # Extract mcp-session-id from response if not in request
            if not mcp_session_id and "mcp-session-id" in response.headers:
                with logger.contextualize(mcp_session_id=response.headers["mcp-session-id"]):
                    logger.debug("Added mcp_session_id from response")

            return response

    return await call_next(request)


@app.middleware("http")
async def mcp_slash_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
):
    """Make /mcp* and /mcp*/ behave the same without actual redirect."""
    path = request.url.path
    if path.startswith("/mcp") and not path.endswith("/"):
        request.scope["path"] = f"{path}/"
        if request.scope.get("raw_path"):
            request.scope["raw_path"] = f"{path}/".encode()
    return await call_next(request)


# Mount routers and apps AFTER middleware
app.include_router(dpage_router)

for mcp_app in mcp_apps:
    app.mount(mcp_app.route, mcp_app.app)

setup_mcp_auth(app, [mcp_app.route for mcp_app in mcp_apps])


@app.get("/docs-mcp")
async def mcp_docs() -> list[MCPDoc]:
    return await asyncio.gather(*[mcp_app_docs(mcp_app) for mcp_app in create_mcp_apps()])


# Serve static homepage
@app.get("/")
def homepage():
    return FileResponse(STATIC_DIR / "index.html")
