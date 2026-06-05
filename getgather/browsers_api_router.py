import asyncio
import json
import os
import urllib.parse
from typing import Any

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.websockets import WebSocketState
from loguru import logger
from starlette.requests import HTTPConnection
from websockets.exceptions import ConnectionClosed

from getgather.browser import call_chromefleet_api
from getgather.cdp_client import PageNotFoundError, open_cdp
from getgather.config import settings
from getgather.podman_browsers import (
    configure_remote_browser,
    container_exists,
    container_host,
    container_is_running,
    get_cdp_url,
    get_container_last_activity,
    get_container_public_ip,
    get_host_port,
    kill_container,
    launch_container,
    list_containers,
)
from getgather.zen_distill import convert, distill, load_distillation_patterns

router = APIRouter()


def _forward_headers(request: HTTPConnection, *names: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name in names:
        value = request.headers.get(name)
        if value:
            headers[name] = value
    return headers


async def get_cdp_websocket_url(browser_id: str) -> str:
    cdp_url = await get_cdp_url(browser_id)

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{cdp_url}/json/version")
        response.raise_for_status()
        data = response.json()
        logger.debug(f"[CDP] CDP json version gives {data}")
        return str(data["webSocketDebuggerUrl"])


async def get_page_websocket_url(browser_id: str, page_id: str) -> str | None:
    try:
        cdp_url = await get_cdp_url(browser_id)

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{cdp_url}/json/list")
            response.raise_for_status()
            data: list[dict[str, Any]] = response.json()
            for item in data:
                if item.get("id") == page_id:
                    return (
                        str(item["webSocketDebuggerUrl"])
                        if "webSocketDebuggerUrl" in item
                        else None
                    )
            return None
    except Exception as e:
        logger.error(f"[CDP] Error getting page websocket URL for {browser_id}/{page_id}: {e}")
        return None


async def get_page_list(browser_id: str) -> list[str]:
    try:
        cdp_url = await get_cdp_url(browser_id)

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{cdp_url}/json/list")
            response.raise_for_status()
            data: list[dict[str, Any]] = response.json()
            return [str(item["id"]) for item in data]
    except Exception as e:
        logger.error(f"[CDP] Error getting page list for {browser_id}: {e}")
        return []


async def find_browser_id(page_id: str) -> str | None:
    containers = await list_containers()
    for container in [c for c in containers if c.startswith("chromium-")]:
        browser_id = container.replace("chromium-", "")
        page_ids = await get_page_list(browser_id)
        if page_id in page_ids:
            return browser_id

    return None


def strip_browser_id_from_target_id(target_id: str) -> str:
    if "@" not in target_id:
        return target_id
    return target_id.split("@", 1)[1]


def prepend_browser_id_to_target_id(target_id: str, browser_id: str) -> str:
    return browser_id + "@" + target_id


CDP_TARGET_METHODS_STRIP_ID = (
    "Target.attachToTarget",
    "Target.closeTarget",
    "Target.getTargetInfo",
)


def patch_cdp_target(message: str, browser_id: str) -> str:
    if "targetId" not in message:
        return message

    try:
        data: Any = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return message

    if isinstance(data, dict):
        if data.get("method") == "Target.targetCreated":  # pyright: ignore[reportUnknownMemberType]
            params: Any = data.get("params")  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
            if isinstance(params, dict):
                target_info: Any = params.get("targetInfo")  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
                if isinstance(target_info, dict) and "targetId" in target_info:
                    target_info["targetId"] = prepend_browser_id_to_target_id(
                        str(target_info["targetId"]),  # pyright: ignore[reportUnknownArgumentType]
                        browser_id,
                    )
                    return json.dumps(data)
        elif data.get("method") in CDP_TARGET_METHODS_STRIP_ID:  # pyright: ignore[reportUnknownMemberType]
            params = data.get("params")  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
            if isinstance(params, dict) and "targetId" in params:
                params["targetId"] = strip_browser_id_from_target_id(str(params["targetId"]))  # pyright: ignore[reportUnknownArgumentType]
                return json.dumps(data)
        elif "result" in data:
            result: Any = data.get("result")  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
            if isinstance(result, dict) and "targetId" in result:
                result["targetId"] = prepend_browser_id_to_target_id(
                    str(result["targetId"]),  # pyright: ignore[reportUnknownArgumentType]
                    browser_id,
                )
                return json.dumps(data)

    return message


async def websocket_proxy(client_ws: WebSocket, remote_url: str, browser_id: str) -> None:
    try:
        async with websockets.connect(
            remote_url,
            ping_interval=60,
            ping_timeout=30,
            close_timeout=7200,
            max_size=10 * 1024 * 1024,
        ) as remote_ws:
            logger.info("[CDP] Connected to remote WebSocket")

            async def client_to_remote() -> None:
                try:
                    while True:
                        message = await client_ws.receive_text()
                        message = patch_cdp_target(message, browser_id)
                        logger.debug(f"[CDP] Client -> Remote: {message[:100]}")
                        await remote_ws.send(message)
                except (WebSocketDisconnect, RuntimeError):
                    logger.info("[CDP] Client disconnected")
                except Exception as e:
                    logger.error(f"[CDP] client_to_remote error: {type(e).__name__}: {e}")

            async def remote_to_client() -> None:
                try:
                    async for message in remote_ws:
                        msg_text = message if isinstance(message, str) else message.decode()
                        msg_text = patch_cdp_target(msg_text, browser_id)
                        logger.debug(f"[CDP] Remote -> Client: {msg_text[:100]}")
                        if client_ws.client_state == WebSocketState.CONNECTED:
                            await client_ws.send_text(msg_text)
                        else:
                            logger.debug("[CDP] Client not connected, breaking")
                            break
                except ConnectionClosed as e:
                    logger.info(f"[CDP] Remote disconnected: code={e.code} reason={e.reason}")
                except Exception as e:
                    logger.error(f"[CDP] remote_to_client error: {type(e).__name__}: {e}")

            tasks = [
                asyncio.create_task(client_to_remote()),
                asyncio.create_task(remote_to_client()),
            ]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

            for task in pending:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    except OSError as e:
        logger.error(f"[CDP] Could not connect to remote: {e}")
        if client_ws.client_state == WebSocketState.CONNECTED:
            await client_ws.close(code=4502, reason="Remote server unreachable")
    except Exception as e:
        logger.error(f"[CDP] Unexpected error: {type(e).__name__}: {e}")
        if client_ws.client_state == WebSocketState.CONNECTED:
            await client_ws.close(code=4500, reason="Internal proxy error")


@router.post("/api/v1/browsers/{browser_id}", response_model=None)
async def create_browser(
    browser_id: str, request: HTTPConnection
) -> dict[str, str | None] | JSONResponse:
    if settings.CHROMEFLEET_URL:
        logger.info(f"Proxying create_browser({browser_id}) to external Chrome Fleet")
        response = await call_chromefleet_api(
            "POST",
            browser_id,
            headers=_forward_headers(request, "x-origin-ip"),
        )
        if response is None:
            raise HTTPException(status_code=502, detail="Chrome Fleet request failed")
        return JSONResponse(content=response.json(), status_code=response.status_code)  # pyright: ignore[reportUnknownArgumentType]

    logger.info(f"Starting browser {browser_id}...")
    container_name = f"chromium-{browser_id}"
    try:
        await launch_container(settings.CONTAINER_IMAGE, container_name)
        logger.info(f"Browser {browser_id} is started.")
        origin_ip = request.headers.get("x-origin-ip")
        ip = await configure_remote_browser(browser_id, container_name, origin_ip)
        return {"container_name": container_name, "status": "created", "ip": ip}
    except Exception as e:
        detail = f"Unable to start browser {browser_id}!"
        logger.error(f"{detail} Exception={e}")
        raise HTTPException(status_code=500, detail=detail)


@router.delete("/api/v1/browsers/{browser_id}", response_model=None)
async def delete_browser(browser_id: str) -> dict[str, str] | JSONResponse:
    if settings.CHROMEFLEET_URL:
        logger.info(f"Proxying delete_browser({browser_id}) to external Chrome Fleet")
        response = await call_chromefleet_api("DELETE", browser_id)
        if response is None:
            raise HTTPException(status_code=502, detail="Chrome Fleet request failed")
        return JSONResponse(content=response.json(), status_code=response.status_code)  # pyright: ignore[reportUnknownArgumentType]

    logger.info(f"Stopping browser {browser_id}...")
    container_name = f"chromium-{browser_id}"
    if not await container_exists(container_name):
        detail = f"Browser {browser_id} not found!"
        logger.warning(detail)
        raise HTTPException(status_code=404, detail=detail)
    try:
        await kill_container(container_name)
        logger.info(f"Browser {browser_id} is stopped.")
        return {"container_name": container_name, "status": "deleted"}
    except Exception as e:
        detail = f"Unable to stop browser {browser_id}!"
        logger.error(f"{detail} Exception={e}")
        raise HTTPException(status_code=500, detail=detail)


@router.get("/api/v1/browsers/{browser_id}", response_model=None)
async def get_browser(
    browser_id: str, request: Request
) -> dict[str, float | str | None] | JSONResponse:
    if settings.CHROMEFLEET_URL:
        logger.info(f"Proxying get_browser({browser_id}) to external Chrome Fleet")
        response = await call_chromefleet_api(
            "GET",
            browser_id,
            headers=_forward_headers(request, "x-origin-ip"),
        )
        if response is None:
            raise HTTPException(status_code=502, detail="Chrome Fleet request failed")
        return JSONResponse(content=response.json(), status_code=response.status_code)  # pyright: ignore[reportUnknownArgumentType]

    logger.info(f"Querying browser {browser_id}...")
    container_name = f"chromium-{browser_id}"
    if not await container_is_running(container_name):
        detail = f"Browser {browser_id} not found!"
        logger.warning(detail)
        raise HTTPException(status_code=404, detail=detail)
    last_activity_timestamp = await get_container_last_activity(container_name)
    logger.debug(f"Browser {browser_id}: last_activity_timestamp={last_activity_timestamp}.")
    origin_ip = request.headers.get("x-origin-ip")
    if origin_ip:
        ip = await configure_remote_browser(browser_id, container_name, origin_ip)
    else:
        ip = await get_container_public_ip(container_name)
    return {"last_activity_timestamp": last_activity_timestamp, "ip": ip}


@router.get("/api/v1/browsers")
async def list_browsers() -> JSONResponse:
    if settings.CHROMEFLEET_URL:
        logger.info("Proxying list_browsers() to external Chrome Fleet")
        response = await call_chromefleet_api("GET")
        if response is None:
            raise HTTPException(status_code=502, detail="Chrome Fleet request failed")
        return JSONResponse(content=response.json(), status_code=response.status_code)  # pyright: ignore[reportUnknownArgumentType]

    logger.info("Enumerating all browsers...")
    try:
        containers = await list_containers()
        all_browsers = [c[len("chromium-") :] for c in containers if c.startswith("chromium-")]
        return JSONResponse(all_browsers)
    except Exception as e:
        detail = "Unable to list all browsers"
        logger.error(f"{detail} Exception={e}")
        raise HTTPException(status_code=500, detail=detail)


@router.get("/api/v1/browsers/{browser_id}/pages")
async def list_pages(browser_id: str) -> JSONResponse:
    try:
        client = await open_cdp(browser_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Browser {browser_id} not found!")

    try:
        result = await client.send("Target.getTargets")
    except Exception as e:
        logger.error(f"Error listing pages via CDP for {browser_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to list pages: {e}")
    finally:
        await client.aclose()

    target_infos: list[dict[str, Any]] = result.get("targetInfos", [])  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
    page_ids = [str(info["targetId"]) for info in target_infos if info.get("type") == "page"]
    return JSONResponse(page_ids)


@router.get("/api/v1/browsers/{browser_id}/pages/{page_id}/html")
async def get_page_html(browser_id: str, page_id: str) -> HTMLResponse:
    page_id = strip_browser_id_from_target_id(page_id)
    try:
        client = await open_cdp(browser_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Browser {browser_id} not found!")

    try:
        try:
            page = await client.attach_to_page(page_id)
        except PageNotFoundError:
            raise HTTPException(status_code=404, detail=f"Page {page_id} not found in browser")
        except Exception as e:
            logger.error(f"Failed to attach to {browser_id}/{page_id}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to get page HTML: {e}")

        try:
            html = await page.evaluate("document.documentElement.outerHTML")
        except Exception as e:
            logger.error(f"Error fetching page HTML for {browser_id}/{page_id}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to get page HTML: {e}")

        if not isinstance(html, str):
            html = str(html) if html is not None else ""
        return HTMLResponse(content=html)
    finally:
        await client.aclose()


@router.get("/api/v1/browsers/{browser_id}/pages/{page_id}/distilled")
async def get_page_distilled(browser_id: str, page_id: str) -> JSONResponse:
    page_id = strip_browser_id_from_target_id(page_id)
    try:
        client = await open_cdp(browser_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Browser {browser_id} not found!")

    try:
        try:
            page = await client.attach_to_page(page_id)
        except PageNotFoundError:
            raise HTTPException(status_code=404, detail=f"Page {page_id} not found in browser")
        except Exception as e:
            logger.error(f"Failed to attach to {browser_id}/{page_id}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to distill page: {e}")

        try:
            current_url = str(await page.evaluate("window.location.href", await_promise=True))
            hostname = urllib.parse.urlparse(current_url).hostname or ""

            path = os.path.join(os.path.dirname(__file__), "mcp", "patterns", "*.html")
            patterns = load_distillation_patterns(path)
            if not patterns:
                raise HTTPException(status_code=502, detail="No patterns found for '*.html'")

            match = await distill(hostname, page, patterns)  # type: ignore[arg-type]
            if not match:
                raise HTTPException(status_code=502, detail="No matching pattern found for page")

            converted = await convert(match.distilled, pattern_path=match.name)
            if converted:
                return JSONResponse(converted)

            return JSONResponse({"distilled": match.distilled})
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error distilling page for {browser_id}/{page_id}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to distill page: {e}")
    finally:
        await client.aclose()


@router.post("/api/v1/browsers/{browser_id}/pages/{page_id}/navigate")
@router.get("/api/v1/browsers/{browser_id}/pages/{page_id}/navigate")
async def navigate_page(
    browser_id: str,
    page_id: str,
    request: Request,
    url: str | None = None,
) -> JSONResponse:
    target_url = url if url is not None else request.url.query
    if not target_url:
        raise HTTPException(status_code=400, detail="Missing 'url' query parameter")

    page_id = strip_browser_id_from_target_id(page_id)
    try:
        client = await open_cdp(browser_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Browser {browser_id} not found!")

    try:
        try:
            page = await client.attach_to_page(page_id)
        except PageNotFoundError:
            raise HTTPException(status_code=404, detail=f"Page {page_id} not found in browser")
        except Exception as e:
            logger.error(f"Failed to attach to {browser_id}/{page_id}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to navigate page: {e}")

        try:
            await page.navigate(target_url)
        except Exception as e:
            logger.error(f"Error navigating page for {browser_id}/{page_id}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to navigate page: {e}")

        return JSONResponse({"status": "success"})
    finally:
        await client.aclose()


@router.websocket("/cdp/{browser_id}")
async def cdp_browser_websocket_proxy(client_ws: WebSocket, browser_id: str) -> None:
    logger.debug(f"[CDP] Entered cdp_browser_websocket_proxy for browser_id={browser_id}")
    container_name = f"chromium-{browser_id}"

    await client_ws.accept()
    logger.debug("[CDP] WebSocket accepted")

    if not await container_exists(container_name):
        logger.info(f"[CDP] Container {container_name} not found — launching")
        try:
            await create_browser(browser_id, client_ws)
            logger.info(f"[CDP] Container {container_name} started")
        except Exception as e:
            logger.error(f"[CDP] Failed to auto-start container {container_name}: {e}")
            await client_ws.close(code=1008)
            return

    remote_url = None
    for attempt in range(10):
        try:
            remote_url = await get_cdp_websocket_url(browser_id)
            logger.info(f"[CDP] Got remote URL: {remote_url}")
            break
        except Exception as e:
            logger.warning(
                f"[CDP] Attempt {attempt + 1}/10 failed to get debugger URL from {browser_id}: {e}"
            )
            if attempt < 9:
                logger.debug("[CDP] Retrying in 3 seconds...")
                await asyncio.sleep(3)
            else:
                logger.error("[CDP] All retry attempts exhausted")
                await client_ws.close(code=4502, reason="Failed to get debugger URL")
                return

    if not remote_url:
        logger.error("[CDP] No remote URL obtained")
        await client_ws.close(code=4502, reason="Failed to get debugger URL")
        return

    logger.info(f"[CDP] Client connected, proxying to {remote_url}")
    await websocket_proxy(client_ws, remote_url, browser_id)
    logger.debug("[CDP] cdp_browser_websocket_proxy exiting")


@router.websocket("/devtools/{path:path}")
async def cdp_devtools_websocket_proxy(client_ws: WebSocket, path: str) -> None:
    logger.debug(f"[CDP] Entered cdp_devtools_websocket_proxy for path={path}")
    await client_ws.accept()
    logger.debug("[CDP] WebSocket accepted")

    parts = path.split("/")
    page_id = parts[-1] if parts else None
    if not page_id:
        logger.error("[CDP] No page_id in path")
        await client_ws.close(code=4000, reason="No page_id in path")
        return

    browser_id = None
    if "@" in page_id:
        id_parts = page_id.split("@")
        browser_id = id_parts[0]
        page_id = id_parts[1]
        logger.debug(f"[CDP] browser_id={browser_id} page_id={page_id}")
    else:
        logger.debug(f"[CDP] Looking for page_id={page_id}")
        browser_id = await find_browser_id(page_id)
        if browser_id:
            logger.debug(f"[CDP] Found page {page_id} in browser {browser_id}")
        else:
            logger.error(f"[CDP] Page {page_id} not found in any browser")
            await client_ws.close(code=4000, reason="Page not found in any browser")
            return

    remote_url = await get_page_websocket_url(browser_id, page_id)
    if not remote_url:
        logger.error(f"[CDP] Could not get websocket URL for page {page_id}")
        await client_ws.close(code=4502, reason="Failed to get page websocket URL")
        return

    logger.info(f"[CDP] Connecting to {remote_url}")
    await websocket_proxy(client_ws, remote_url, browser_id)
    logger.debug("[CDP] cdp_devtools_websocket_proxy exiting")


@router.get("/live/{browser_id}")
async def vnc_live_viewer(browser_id: str) -> HTMLResponse:
    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>{browser_id} - Live View</title>
    <style>
        body {{ margin: 0; background: #000; }}
        #screen {{ width: 100vw; height: 100vh; }}
    </style>
</head>
<body>
    <div id="screen"></div>
    <script type="module">
        import RFB from '/rfb.min.js';

        const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = wsScheme + '://' + window.location.host + '/websockify/{browser_id}';

        const rfb = new RFB(
            document.getElementById('screen'),
            wsUrl
        );
        rfb.scaleViewport = true;
    </script>
</body>
</html>"""
    return HTMLResponse(html)


@router.websocket("/websockify/{browser_id}")
async def websockify_proxy(websocket: WebSocket, browser_id: str) -> None:
    container_name = f"chromium-{browser_id}"
    vnc_port = await get_host_port(container_name, 5900)
    if not vnc_port:
        await websocket.close()
        return

    client_subprotocol = websocket.headers.get("sec-websocket-protocol")
    if client_subprotocol and "binary" in [p.strip() for p in client_subprotocol.split(",")]:
        await websocket.accept(subprotocol="binary")
    else:
        await websocket.accept()

    try:
        reader, writer = await asyncio.open_connection(container_host(), vnc_port)
    except Exception:
        await websocket.close()
        return

    async def ws_to_vnc() -> None:
        try:
            while True:
                data = await websocket.receive_bytes()
                writer.write(data)
                await writer.drain()
        except Exception:
            pass

    async def vnc_to_ws() -> None:
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                await websocket.send_bytes(data)
        except Exception:
            pass

    await asyncio.gather(ws_to_vnc(), vnc_to_ws())
    writer.close()
    await writer.wait_closed()
