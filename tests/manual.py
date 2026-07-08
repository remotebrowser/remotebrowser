import asyncio
import traceback
from typing import Annotated

from cyclopts import App, Parameter
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from rich import print

app = App(help="Manual end-to-end test of the mcp server.")


@app.command(
    help="""Call an mcp tool. Examples:\n
    * python tests/manual.py call-tool
    * python tests/manual.py call-tool --tool npr_get_headlines
    * python tests/manual.py call-tool --mcp media --tool bbc_get_saved_articles
    * python tests/manual.py call-tool --token TOKEN
    """
)
async def call_tool(
    server_url: Annotated[str, Parameter(help="URL of the mcp server")] = "http://localhost:23456",
    mcp: Annotated[str, Parameter(help="name of the mcp server")] = "media",
    tool: Annotated[str, Parameter(help="name of the tool")] = "get_browser_ip_address",
    token: Annotated[str, Parameter(help="OAuth token to skip full auth flow")] | None = None,
):
    url = f"{server_url}/mcp-{mcp}"
    result = None
    error = None
    transport = StreamableHttpTransport(
        url,
        auth=(token or "oauth"),
        headers={"x-origin-ip": await _get_ip()},
        sse_read_timeout=180,
    )
    try:
        async with Client(transport) as client:
            result = await client.call_tool_mcp(tool, {})
    except Exception:
        error = traceback.format_exc()

    msg = f"Tool call:\n  mcp server: {url}\n  tool: {tool}"
    if token:
        msg = f"{msg}\n  token: {token}"

    print(msg)
    if error:
        print("Error:")
        print(error)
    else:
        print("Result:")
        print(result)


async def _get_ip():
    proc = await asyncio.create_subprocess_exec(
        "curl",
        "-s",
        "https://api4.ipify.org",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
    ip = stdout.decode().strip()
    print(f"Using IP: {ip}")
    return ip


if __name__ == "__main__":
    app()
