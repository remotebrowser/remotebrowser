import asyncio
import math
import os
import subprocess
import sys
from datetime import datetime
from typing import Any

from loguru import logger

from getgather.browsers.backend import BROWSER_NAME_PREFIX, BrowserNotFound
from getgather.browsers.residential_proxy import get_proxy_config
from getgather.config import settings

DOCKER_INTERNAL_HOST = "172.17.0.1"


async def run_podman(args: list[str]) -> tuple[str, str]:
    cmd = ["podman"]
    if settings.CONTAINER_HOST:
        cmd.append("--remote")
    cmd.extend(args)
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode or -1, cmd, stdout, stderr)
    return stdout, stderr


async def get_host_port(container_name: str, container_port: int) -> int | None:
    try:
        stdout, _ = await run_podman(["port", container_name, str(container_port)])
        port_mapping = stdout.strip()
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
    if settings.CONTAINER_HOST:
        cmd.extend(["--cpus", "1", "--memory", "2048m"])
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
        stdout, _ = await run_podman(cmd)
        if stdout:
            container_id = stdout.strip()
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
        await run_podman(["container", "exists", container_name])
        return True
    except subprocess.CalledProcessError:
        return False


async def container_is_running(container_name: str) -> bool:
    try:
        stdout, _ = await run_podman(["inspect", "--format", "{{.State.Running}}", container_name])
        return stdout.strip() == "true"
    except subprocess.CalledProcessError:
        return False


async def kill_container(container_name: str) -> None:
    logger.info(f"Killing Chromium container {container_name}...")
    try:
        stdout, _ = await run_podman(["kill", container_name])
        if stdout:
            logger.info(f"Container killed: name={container_name}")
        else:
            raise Exception(f"Unable to kill container {container_name}")
    except subprocess.CalledProcessError as e:
        raise Exception(f"Unable to kill container {container_name}: {e}")


async def list_containers() -> list[str]:
    logger.debug("Retrieving the list of all containers...")
    try:
        stdout, _ = await run_podman(["container", "ls", "--format", "{{.Names}}"])
        containers = stdout.splitlines() if stdout else []
        logger.debug(f"All containers obtained. Total={len(containers)}")
        return containers
    except subprocess.CalledProcessError as e:
        raise Exception(f"Unable to list all containers: {e}")


async def get_container_last_activity(container_name: str) -> float | None:
    try:
        await run_podman([
            "exec",
            container_name,
            "sh",
            "-c",
            "cp /home/user/chrome-profile/Default/History db",
        ])

        stdout, _ = await run_podman([
            "exec",
            container_name,
            "sqlite3",
            "db",
            "select MAX(last_visit_time) from urls;",
        ])

        if stdout:
            chromium_time = float(stdout.strip())
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
            await run_podman([
                "exec",
                container_name,
                "sed",
                "-i",
                "/^Upstream http/d",
                "/app/tinyproxy.conf",
            ])
            await run_podman([
                "exec",
                container_name,
                "sed",
                "-i",
                f"$ a\\Upstream http {proxy_url}",
                "/app/tinyproxy.conf",
            ])
            logger.info(f"Restarting tinyproxy in {container_name}...")
            await run_podman([
                "exec",
                container_name,
                "sh",
                "-c",
                "pkill tinyproxy || true",
            ])
            await run_podman([
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


def container_host() -> str:
    return DOCKER_INTERNAL_HOST if os.path.exists("/.dockerenv") else "127.0.0.1"


async def get_container_public_ip(
    container_name: str, *, retries: int = 5, retry_delay: float = 2.0
) -> str | None:
    for attempt in range(1, retries + 1):
        try:
            stdout, stderr = await run_podman([
                "exec",
                container_name,
                "curl",
                "-s",
                "--max-time",
                "10",
                "--proxy",
                "http://127.0.0.1:8119",
                "https://ip.fly.dev",
            ])
            ip = stdout.strip() or None
            if ip:
                return ip
            logger.debug(
                f"IP check attempt {attempt}/{retries} in {container_name}: empty response (stderr: {stderr.strip()!r})"
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
    target_domain: str | None,
) -> str | None:
    proxy_config = await get_proxy_config(origin_ip, target_domain, settings)
    proxy_url = proxy_config.get_proxy_url(browser_id) if proxy_config else None

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
    return f"http://{container_host()}:{host_port}"


class PodmanBackend:
    async def shutdown(self) -> None:
        return None

    async def create_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        container_name = f"{BROWSER_NAME_PREFIX}{browser_id}"
        await launch_container(settings.CONTAINER_IMAGE, container_name)
        ip = await configure_remote_browser(browser_id, container_name, origin_ip, target_domain)
        return {"container_name": container_name, "status": "created", "ip": ip}

    async def get_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        container_name = f"{BROWSER_NAME_PREFIX}{browser_id}"
        if not await container_is_running(container_name):
            raise BrowserNotFound(browser_id)
        last_activity_timestamp = await get_container_last_activity(container_name)
        logger.debug(f"Browser {browser_id}: last_activity_timestamp={last_activity_timestamp}.")
        if origin_ip:
            ip = await configure_remote_browser(
                browser_id, container_name, origin_ip, target_domain
            )
        else:
            ip = await get_container_public_ip(container_name)
        return {"last_activity_timestamp": last_activity_timestamp, "ip": ip}

    async def delete_browser(self, browser_id: str) -> dict[str, Any]:
        container_name = f"{BROWSER_NAME_PREFIX}{browser_id}"
        await kill_container(container_name)
        return {"container_name": container_name, "status": "deleted"}

    async def browser_exists(self, browser_id: str) -> bool:
        return await container_exists(f"{BROWSER_NAME_PREFIX}{browser_id}")

    async def list_browser_ids(self) -> list[str]:
        containers = await list_containers()
        return [
            c[len(BROWSER_NAME_PREFIX) :] for c in containers if c.startswith(BROWSER_NAME_PREFIX)
        ]

    async def cleanup_idle(self) -> list[str]:
        browser_ids = await self.list_browser_ids()

        browsers: list[dict[str, Any]] = []
        for browser_id in browser_ids:
            container_name = f"{BROWSER_NAME_PREFIX}{browser_id}"
            last_activity_timestamp = await get_container_last_activity(container_name)
            if last_activity_timestamp is None:
                logger.debug(f"Skipping browser {browser_id}: error retrieving last activity")
                continue
            browsers.append({
                "browser_id": browser_id,
                "last_activity_timestamp": last_activity_timestamp,
            })

        now = datetime.now().timestamp()
        deleted: list[str] = []
        for browser in browsers:
            idle_seconds = now - browser["last_activity_timestamp"]
            idle_minutes = math.ceil(idle_seconds / 60)
            logger.debug(f"Browser {browser['browser_id']} idle for {idle_minutes}m")
            if idle_seconds > settings.MAX_IDLE_MINUTES * 60:
                logger.info(f"Deleting browser {browser['browser_id']} (idle: {idle_minutes}m)")
                try:
                    await self.delete_browser(browser["browser_id"])
                    deleted.append(browser["browser_id"])
                except Exception as e:
                    logger.error(f"Failed to delete browser {browser['browser_id']}: {e}")

        logger.info(f"Cleanup complete: total={len(browser_ids)} deleted={len(deleted)}")
        return deleted

    async def get_cdp_base_url(self, browser_id: str) -> str:
        return await get_cdp_url(browser_id)

    def cdp_websocket_base(self) -> None:
        # Local containers expose CDP per-browser via /json/version (get_cdp_base_url), not a
        # shared websocket proxy, so the router uses that flow rather than a transparent relay.
        return None

    async def get_vnc_endpoint(self, browser_id: str) -> tuple[str, int] | None:
        vnc_port = await get_host_port(f"{BROWSER_NAME_PREFIX}{browser_id}", 5900)
        if not vnc_port:
            return None
        return (container_host(), vnc_port)

    async def get_live_view_url(self, browser_id: str) -> str | None:
        return None
