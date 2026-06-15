from typing import ClassVar

from fastmcp import Context, FastMCP
from loguru import logger


class MCPTool(FastMCP[Context]):
    registry: ClassVar[dict[str, "MCPTool"]] = {}

    def __init__(
        self,
        *,
        brand_id: str,
        name: str,
    ) -> None:
        super().__init__(name=name)  # type: ignore[reportUnknownMemberType]
        self.brand_id = brand_id
        MCPTool.registry[self.brand_id] = self
        logger.debug(f"Registered MCPTool with brand_id '{brand_id}' and name '{name}'")
