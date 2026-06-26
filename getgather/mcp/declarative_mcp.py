from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

import yaml
from loguru import logger
from pydantic import BaseModel

from getgather.mcp.dpage import remote_zen_dpage_mcp_tool
from getgather.mcp.registry import MCPTool

YAML_CONFIG_PATH = Path(__file__).parent / "mcp-tools.yaml"


class ToolConfig(BaseModel):
    function_name: str
    description: str
    result_key: str | None = None
    url: str | None = None
    timeout: int | None = None


class McpConfig(BaseModel):
    id: str
    name: str
    tools: list[ToolConfig] = []
    custom: bool = False
    module: str | None = None


def _load_mcp_config() -> list[McpConfig]:
    with open(YAML_CONFIG_PATH) as f:
        data = yaml.safe_load(f)
    return [McpConfig(**item) for item in data]


DECLARATIVE_MCP_CONFIG: list[McpConfig] = _load_mcp_config()


def create_declarative_mcp_tools() -> None:
    """Create and register MCP tools from configuration array.

    This function generates MCPTool instances and their tools dynamically
    from the DECLARATIVE_MCP_CONFIG array. Tools can be either remote zen dpage tools
    or custom-code modules.

    For custom-code entries (custom: true), the MCPTool is created and then the
    Python module is imported so its @<id>_mcp.tool decorators register tools.
    This function is idempotent — calling it again is a no-op if all entries
    already exist in the registry.
    """

    for config in DECLARATIVE_MCP_CONFIG:
        if config.id in MCPTool.registry:
            logger.debug(f"MCPTool '{config.id}' already registered, skipping")
            continue

        gather_mcp = MCPTool(brand_id=config.id, name=config.name)

        if config.custom:
            module_name: str = config.module or config.id
            import_path = f"getgather.mcp.{module_name}"
            logger.info(f"Loading custom-code module: {import_path}")
            importlib.import_module(import_path)
            continue

        for tool_config in config.tools:
            function_name: str = tool_config.function_name
            description: str = tool_config.description
            url: str = tool_config.url or ""
            result_key: str = tool_config.result_key or ""
            timeout: int = tool_config.timeout if tool_config.timeout is not None else 2

            def make_remote_tool_fn(
                url: str = url,
                result_key: str = result_key,
                timeout: int = timeout,
            ):
                async def tool_func() -> dict[str, Any]:
                    return await remote_zen_dpage_mcp_tool(url, result_key, timeout=timeout)

                return tool_func

            tool_func = make_remote_tool_fn()
            tool_func.__name__ = function_name
            tool_func.__doc__ = description
            gather_mcp.tool(tool_func)


# Run at import time so custom-code modules can look up MCPTool.registry
# (called again from create_mcp_apps() as a safety net; idempotent)
create_declarative_mcp_tools()
