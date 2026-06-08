# Remote Browser

[![PyPI](https://img.shields.io/pypi/v/remotebrowser)](https://pypi.org/project/remotebrowser/)

Remote Browser is an open-source, self-hosted browser orchestration system for AI agent [harness engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

It launches and manages multiple isolated, containerized Chrome instances with CDP ([Chrome Devtools Protocol](https://chromedevtools.github.io/devtools-protocol/)) support for scalable web automation. Remote Browser is designed to integrate with AI agent runtimes and browser tools, and works with [OpenClaw](https://openclaw.ai), [Hermes Agent](https://hermes-agent.nousresearch.com), etc.

It also bundles an MCP server for extracting personal data from many services: Amazon order history, Garmin activity stats, Zillow favorites, and more. This MCP server works with [Claude Code](https://claude.ai/code), [LM Studio](https://lmstudio.ai), [Gemini CLI](https://google-gemini.github.io/gemini-cli), and many more.

![Screenshot of Claude Code using Remote Browser MCP](claude-code-remotebrowser-mcp.png)

## Quickstart

Remote Browser is a Python app. To run it, you need [uv](https://docs.astral.sh/uv) and [Podman](https://podman.io):

```bash
uvx remotebrowser
```

Then open `http://localhost:23456`.

## MCP

**Standard config** works with most tools:

```js
{
  "mcpServers": {
    "remotebrowser-mcp": {
      "url": "http://127.0.0.1:23456/mcp"
    }
  }
}
```

<details>
<summary>Claude Code</summary>

Use the Claude Code CLI to add the MCP server:

```bash
claude mcp add --transport http remotebrowser-mcp http://localhost:23456/mcp
```

</details>

<details>
<summary>Claude Desktop</summary>

Follow the MCP install [guide](https://modelcontextprotocol.io/quickstart/user), use the standard config above.

</details>

<details>
<summary>Gemini CLI</summary>

Follow the MCP install [guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md#configure-the-mcp-server-in-settingsjson), use the standard config above.

</details>

<details>
<summary>LM Studio</summary>

Go to `Program` in the right sidebar -> `Install` -> `Edit mcp.json`. Use the standard config above.

</details>

<details>
<summary>VS Code</summary>

Follow the MCP install [guide](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_add-an-mcp-server), use the standard config above.

</details>

## API

### Start a new browser

`POST /api/v1/browsers/{browser_id}` creates a new browser with the specified `browser_id`. The browser runs in a container.

_Example_: `curl -X POST localhost:8300/api/v1/browsers/xyz123` creates a container named `chromium-xyz123` and returns:

```json
{ "container_name": "chromium-xyz123", "status": "created" }
```

### Stop a browser

`DELETE /api/v1/browsers/{browser_id}` terminates the browser with the specified `browser_id` and returns the container name. Returns HTTP 404 if the browser ID is not found.

_Example_: `curl -X DELETE localhost:8300/api/v1/browsers/xyz123` terminates the container named `chromium-xyz123` and returns:

```json
{ "container_name": "chromium-xyz123", "status": "deleted" }
```

### Query a browser

`GET /api/v1/browsers/{browser_id}` returns information about the browser with the specified `browser_id`. Returns HTTP 404 if the browser is not found.

_Example_: `curl localhost:8300/api/v1/browsers/xyz123` returns:

```json
{ "last_activity_timestamp": 1772069081 }
```

### List all browsers

`GET /api/v1/browsers` returns a JSON array of all running browser IDs.

_Example_: `curl localhost:8300/api/v1/browsers` returns:

```json
["xyz123", "abc234"]
```

### List pages of a browser

`GET /api/v1/browsers/{browser_id}/pages` returns a JSON array of page identifiers (CDP target IDs) for all open pages in the specified browser. Returns HTTP 404 if the browser is not found.

_Example_: `curl localhost:23456/api/v1/browsers/test/pages` returns:

```json
["96FDE4162B8EEEBF98E26756D21CF0C5"]
```

### Get page HTML

`GET /api/v1/browsers/{browser_id}/pages/{page_id}/html` returns the raw HTML of the specified page. Returns HTTP 404 if the browser or page is not found.

_Example_: `curl localhost:23456/api/v1/browsers/test/pages/96FDE4162B8EEEBF98E26756D21CF0C5/html`

### Get distilled page JSON

`GET /api/v1/browsers/{browser_id}/pages/{page_id}/distilled` returns the distilled JSON representation of the specified page, produced by matching the page against distillation patterns. Returns HTTP 404 if the browser or page is not found.

_Example_: `curl localhost:23456/api/v1/browsers/test/pages/96FDE4162B8EEEBF98E26756D21CF0C5/distilled`

## Development

To run the development version, clone this repository and run:

```bash
uv run -m uvicorn getgather.main:app --port 23456
```

## Deployment

Supported deployment:

- [Deploy using Dokku](deploy-dokku.md)
