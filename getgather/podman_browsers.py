import asyncio
import os
import subprocess
import sys

from loguru import logger

from getgather.config import settings
from getgather.residential_proxy import MassiveLocation, MassiveProxy

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


def container_host() -> str:
    return DOCKER_INTERNAL_HOST if os.path.exists("/.dockerenv") else "127.0.0.1"


async def get_container_public_ip(
    container_name: str, *, retries: int = 5, retry_delay: float = 2.0
) -> str | None:
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
    return f"http://{container_host()}:{host_port}"
