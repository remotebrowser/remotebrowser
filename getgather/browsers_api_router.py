import asyncio
import json
import os
import subprocess
import sys
from typing import Any

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.websockets import WebSocketState
from loguru import logger
from starlette.requests import HTTPConnection
from websockets.exceptions import ConnectionClosed

from getgather.config import settings
from getgather.residential_proxy import MassiveLocation, MassiveProxy

router = APIRouter()

DOCKER_INTERNAL_HOST = "172.17.0.1"


def run_podman(args: list[str]) -> subprocess.CompletedProcess[str]:
    cmd = ["podman"]
    if settings.CONTAINER_HOST:
        cmd.append("--remote")
    cmd.extend(args)
    return subprocess.run(
        cmd, capture_output=True, text=True, check=True, encoding="utf-8", errors="replace"
    )


async def get_host_port(container_name: str, container_port: int) -> int | None:
    try:
        result = run_podman(["port", container_name, str(container_port)])
        port_mapping = result.stdout.strip()
        if not port_mapping:
            return None
        host_port = int(port_mapping.split(":")[-1])
        return host_port
    except subprocess.CalledProcessError:
        return None


async def launch_container(image_name: str, container_name: str) -> str:
    logger.info(f"Launching Chromium container as {container_name}...")
    cmd = [
        "run",
        "-d",
        "--rm",
        "--name",
        container_name,
    ]
    # Apply limits during real production with cgroups v2.
    if settings.CONTAINER_HOST:
        cmd.extend(["--cpus", "1", "--memory", "2048m"])
    # On macOS, Podman runs in a VM. This specific container image requires --privileged
    # to correctly access system services (like DBus) and devices inside that VM.
    if sys.platform == "darwin":
        cmd.append("--privileged")

    cmd.extend([
        "-p",
        "9222",
        "-p",
        "5900",
        image_name,
    ])
    try:
        result = run_podman(cmd)
        if result.returncode == 0 and result.stdout:
            container_id = result.stdout.strip()
            cdp_port = await get_host_port(container_name, 9222)
            vnc_port = await get_host_port(container_name, 5900)
            logger.info(
                f"Container started: name={container_name} id={container_id} cdp_port={cdp_port} vnc_port={vnc_port}"
            )
            return container_id
        raise Exception(f"Unable to launch Chromium for {container_name}")
    except subprocess.CalledProcessError as e:
        raise Exception(f"Unable to launch Chromium for {container_name}: {e}")


async def container_exists(container_name: str) -> bool:
    try:
        result = run_podman(["container", "exists", container_name])
        return result.returncode == 0
    except subprocess.CalledProcessError:
        return False


async def container_is_running(container_name: str) -> bool:
    try:
        result = run_podman(["inspect", "--format", "{{.State.Running}}", container_name])
        return result.stdout.strip() == "true"
    except subprocess.CalledProcessError:
        return False


async def kill_container(container_name: str) -> None:
    logger.info(f"Killing Chromium container {container_name}...")
    try:
        result = run_podman(["kill", container_name])
        if result.returncode == 0 and result.stdout:
            logger.info(f"Container killed: name={container_name}")
        else:
            raise Exception(f"Unable to kill container {container_name}")
    except subprocess.CalledProcessError as e:
        raise Exception(f"Unable to kill container {container_name}: {e}")


async def list_containers() -> list[str]:
    logger.debug("Retrieving the list of all containers...")
    try:
        result = run_podman(["container", "ls", "--format", "{{.Names}}"])
        if result.returncode == 0:
            containers = result.stdout.splitlines() if result.stdout else []
            logger.debug(f"All containers obtained. Total={len(containers)}")
            return containers
        else:
            raise Exception("Unable to list all containers")
    except subprocess.CalledProcessError as e:
        raise Exception(f"Unable to list all containers: {e}")


async def get_container_last_activity(container_name: str) -> float | None:
    try:
        run_podman([
            "exec",
            container_name,
            "sh",
            "-c",
            "cp $HOME/chrome-profile/Default/History db",
        ])

        result = run_podman([
            "exec",
            container_name,
            "sqlite3",
            "db",
            "select MAX(last_visit_time) from urls;",
        ])

        if result.returncode == 0 and result.stdout:
            chromium_time = float(result.stdout.strip())
            unix_epoch = (chromium_time / 1_000_000) - 11644473600
            return unix_epoch
        return None
    except subprocess.CalledProcessError:
        return None
    except Exception:
        return None


async def configure_container(container_name: str, proxy_url: str | None) -> None:
    logger.info(f"Configuring container {container_name} with proxy_url={proxy_url}...")

    if proxy_url:
        try:
            proxy_url = proxy_url.removeprefix("http://")
            logger.debug(f"Configuring proxy with proxy_url: {proxy_url}")
            logger.info(f"Modifying tinyproxy.conf in {container_name}...")
            run_podman([
                "exec",
                container_name,
                "sed",
                "-i",
                "/^Upstream http/d",
                "/app/tinyproxy.conf",
            ])
            run_podman([
                "exec",
                container_name,
                "sed",
                "-i",
                f"$ a\\Upstream http {proxy_url}",
                "/app/tinyproxy.conf",
            ])
            logger.info(f"Restarting tinyproxy in {container_name}...")
            run_podman([
                "exec",
                container_name,
                "sh",
                "-c",
                "pkill tinyproxy || true",
            ])
            run_podman([
                "exec",
                container_name,
                "sh",
                "-c",
                "tinyproxy -d -c /app/tinyproxy.conf &",
            ])
            logger.info(f"Proxy configured successfully in {container_name}.")
        except subprocess.CalledProcessError as e:
            raise Exception(f"Error configuring proxy: {e}")
        except Exception as e:
            logger.error(f"Error configuring proxy: {e}")


def _container_host() -> str:
    return DOCKER_INTERNAL_HOST if os.path.exists("/.dockerenv") else "127.0.0.1"


async def get_container_public_ip(
    container_name: str, *, retries: int = 5, retry_delay: float = 2.0
) -> str | None:
    """Returns the public IP as seen through tinyproxy (port 8119) inside the container.

    Uses --proxy so the request routes through tinyproxy the same way Chrome does,
    giving a true picture of the IP the browser will appear to have.

    Retries on failure to handle tinyproxy still starting up.
    """
    for attempt in range(1, retries + 1):
        try:
            result = await asyncio.to_thread(
                run_podman,
                [
                    "exec",
                    container_name,
                    "curl",
                    "-s",
                    "--max-time",
                    "10",
                    "--proxy",
                    "http://127.0.0.1:8119",
                    "https://ip.fly.dev",
                ],
            )
            ip = result.stdout.strip() or None
            if ip:
                return ip
            logger.debug(
                f"IP check attempt {attempt}/{retries} in {container_name}: empty response (stderr: {result.stderr.strip()!r})"
            )
        except subprocess.CalledProcessError as e:
            logger.debug(
                f"IP check attempt {attempt}/{retries} in {container_name} failed (exit {e.returncode}): {e.stderr.strip()!r}"
            )
        except Exception as e:
            logger.debug(f"IP check attempt {attempt}/{retries} in {container_name} failed: {e}")
        if attempt < retries:
            await asyncio.sleep(retry_delay)
    logger.warning(f"IP check in {container_name} failed after {retries} attempts")
    return None


async def configure_remote_browser(
    browser_id: str,
    container_name: str,
    origin_ip: str | None,
) -> str | None:
    """Resolves proxy/location settings and applies configuration to a container.

    origin_ip should be sourced from the x-origin-ip request header, passed at browser creation.
    Returns the container's public IP after configuration (post-proxy if a proxy was applied), or None.
    """
    if origin_ip and not settings.MAXMIND_ENABLED:
        logger.warning(
            f"x-origin-ip={origin_ip} provided but MaxMind is not configured (missing MAXMIND_ACCOUNT_ID/MAXMIND_LICENSE_KEY) — location will not be resolved"
        )
    if origin_ip and not settings.MASSIVE_PROXY_ENABLED:
        logger.warning(
            f"x-origin-ip={origin_ip} provided but Massive proxy is not configured (missing MASSIVE_PROXY_USERNAME/MASSIVE_PROXY_PASSWORD) — proxy will not be set"
        )
    proxy_url: str | None = None
    if settings.MASSIVE_PROXY_ENABLED:
        location: MassiveLocation | None = None

        if origin_ip:
            if settings.MAXMIND_ENABLED:
                logger.debug(f"Looking up location for x-origin-ip={origin_ip}")
                location = await MassiveProxy.get_location(
                    origin_ip, settings.MAXMIND_ACCOUNT_ID, settings.MAXMIND_LICENSE_KEY
                )
                if location:
                    logger.info(
                        f"MaxMind resolved {origin_ip} -> country={location.country} subdivision={location.subdivision} city={location.city}"
                    )
                else:
                    logger.warning(f"MaxMind returned no location for x-origin-ip={origin_ip}")

        if location:
            proxy_url = MassiveProxy.format_url(
                location,
                session_id=browser_id,
                username=settings.MASSIVE_PROXY_USERNAME,
                password=settings.MASSIVE_PROXY_PASSWORD,
            )
            logger.debug(f"Generated MassiveProxy proxy_url for browser {browser_id}: {proxy_url}")
    ip_before = await get_container_public_ip(container_name)
    logger.debug(f"Browser {browser_id} IP before applying config: {ip_before}")

    await configure_container(container_name, proxy_url)

    if proxy_url:
        ip_after = await get_container_public_ip(container_name)
        if ip_before and ip_after:
            if ip_before != ip_after:
                logger.info(f"Browser {browser_id} IP changed: {ip_before} -> {ip_after}")
            else:
                logger.warning(
                    f"Browser {browser_id} IP unchanged after proxy configuration: {ip_before}"
                )
        return ip_after
    return ip_before


async def get_cdp_url(browser_id: str) -> str:
    container_name = f"chromium-{browser_id}"
    host_port = await get_host_port(container_name, 9222)
    if not host_port:
        raise Exception(f"CDP port not found for {container_name}")
    return f"http://{_container_host()}:{host_port}"


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
                    target_info["targetId"] = browser_id + "@" + str(target_info["targetId"])  # pyright: ignore[reportUnknownArgumentType]
                    return json.dumps(data)
        elif data.get("method") in CDP_TARGET_METHODS_STRIP_ID:  # pyright: ignore[reportUnknownMemberType]
            params = data.get("params")  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
            if isinstance(params, dict) and "targetId" in params:
                target_id = str(params["targetId"])  # pyright: ignore[reportUnknownArgumentType]
                if "@" in target_id:
                    params["targetId"] = target_id.split("@", 1)[1]
                    return json.dumps(data)
        elif "result" in data:
            result: Any = data.get("result")  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
            if isinstance(result, dict) and "targetId" in result:
                result["targetId"] = browser_id + "@" + str(result["targetId"])  # pyright: ignore[reportUnknownArgumentType]
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


@router.post("/api/v1/browsers/{browser_id}")
async def create_browser(browser_id: str, request: HTTPConnection) -> dict[str, str | None]:
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


@router.delete("/api/v1/browsers/{browser_id}")
async def delete_browser(browser_id: str) -> dict[str, str]:
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


@router.get("/api/v1/browsers/{browser_id}")
async def get_browser(browser_id: str, request: Request) -> dict[str, float | str | None]:
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
    logger.info("Enumerating all browsers...")
    try:
        containers = await list_containers()
        all_browsers = [c[len("chromium-") :] for c in containers if c.startswith("chromium-")]
        return JSONResponse(all_browsers)
    except Exception as e:
        detail = "Unable to list all browsers"
        logger.error(f"{detail} Exception={e}")
        raise HTTPException(status_code=500, detail=detail)


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
        reader, writer = await asyncio.open_connection(_container_host(), vnc_port)
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
