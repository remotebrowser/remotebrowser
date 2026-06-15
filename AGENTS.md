# AGENTS Instructions

This file provides guidance when working with code in this repository.

## Overview

A FastAPI + FastMCP server (`getgather`) that exposes MCP tools for extracting personal data from many web services (Amazon, Garmin, YouTube, Goodreads, Zillow, Wayfair, Kroger, etc.). It drives a remote [Chrome Fleet](https://github.com/remotebrowser/chromefleet) instance via [zendriver](https://github.com/stephanlensky/zendriver) (CDP). The server itself is stateless; browser sessions live in the Chrome Fleet backend identified by `browser_id`.

**`CHROMEFLEET_URL` is required** — the server exits on startup if unset.

## Common Commands

```bash
# Dev server (requires CHROMEFLEET_URL)
npm run dev                      # uvicorn on :23456, --reload
# or: uv run -m uvicorn getgather.main:app --port 23456

# Static analysis (matches CI + pre-push hook)
npm run check:all                # all of the below
npm run backend:check:format     # ruff check + ruff format --check
npm run backend:format           # ruff format + ruff check --fix
npm run backend:check:type-safety # pyright . (strict mode)
npm run frontend:check:format    # prettier check on html/js/ts/css/json/md
npm run yaml:check:format        # yamlfix --check (skips mcp-tools.yaml)

# Tests (markers: mcp, distill; anything else = unit)
uv run pytest -m "not api and not webui and not mcp and not distill"  # unit tests (CI)
uv run pytest -m "mcp" -s -p no:xdist                                  # integration vs live server
uv run pytest -m "distill" -s -p no:xdist                              # distillation vs Chrome Fleet
uv run pytest tests/mcp/test_goodreads.py                              # single test file
uv run pytest tests/mcp/test_goodreads.py::test_goodreads_login_and_get_book_list

# Manual MCP client (fastmcp client against running server)
uv run python tests/manual.py call-tool --mcp media --tool bbc_get_saved_articles
```

## Architecture

### MCP app composition

`getgather.main` mounts FastAPI app. `getgather.mcp.main.create_mcp_apps()` builds several MCP ASGI apps from one brand registry:

- `/mcp` — all brands mounted (`type="all"`)
- `/mcp-<brand_id>` — one app per brand (e.g. `/mcp-amazon`)
- `/mcp-<category>` — category bundles defined in `MCP_BUNDLES` (media, books, shopping, sports, food)

All brands are registered in `getgather/mcp/mcp-tools.yaml`. `declarative_mcp.py` creates `MCPTool` instances from the YAML config at import time (module-level), populating `MCPTool.registry`. The parent MCP app then `mount()`s each brand MCP with its `brand_id` as namespace, so tools appear as `<brand_id>_<tool_name>` (e.g. `goodreads_get_book_list`).

Adding a new brand requires: (1) add a YAML entry in `mcp-tools.yaml` with `id`, `name`, and `tools` list, plus `custom: true` and `module: <module_name>` if it has a custom Python module, (2) if custom, the module must look up its MCPTool via `MCPTool.registry["<brand_id>"]` and register tools with `@brand_mcp.tool`.

### Declarative vs imperative brands

All brands are declared in YAML at `getgather/mcp/mcp-tools.yaml`. `declarative_mcp.create_declarative_mcp_tools()` runs at module level and creates `MCPTool` instances from YAML for every brand. Two registration modes:

- **Declarative** (no `custom: true`): tools are auto-generated from YAML config. Two tool kinds:
  - default: `remote_zen_dpage_mcp_tool(url, result_key, timeout)` — full sign-in flow via dpage
  - `short_lived: true`: `short_lived_mcp_tool(location, pattern_wildcard, result_key, hostname)` — one-off scrape for public pages (CNN, ESPN, Ground News, NPR, NYTimes)

- **Custom** (`custom: true`, `module: <name>`): declarative_mcp creates the MCPTool, then dynamically imports the brand module. The module looks up `MCPTool.registry["<brand_id>"]` and uses `@brand_mcp.tool` to register tools with custom logic (post-signin actions, JSON response interception, multi-page flows) via `remote_zen_dpage_with_action(initial_url, action)` where `action` is an `async (page, browser) -> dict`.

### Distillation engine (`zen_distill.py`)

The extraction approach: HTML pattern files in `getgather/mcp/patterns/*.html` contain minimal skeletons with `gg-match="<selector>"` attributes. For each page load, `distill()` batch-extracts all selectors via CDP, finds the best-matching pattern by priority, and renders a "distilled" form. Key markers:

- `gg-match="selector"` — required selector
- `gg-match-html="selector"` — capture inner HTML instead of text
- `gg-optional` — don't fail the pattern if missing
- `gg-priority="N"` — lower wins
- `gg-domain="example.com"` — only try this pattern on matching hostnames
- `gg-stop` — pattern signals the flow is finished (terminate)
- `gg-error="code"` — pattern signals a known error
- `gg-autoclick` — after fields fill, auto-click
- `gg-convert="file.json"` — point at a sibling JSON converter for structured output
- An inline `<script type="application/json">` in the pattern can also define the converter (`rows` selector + `columns` list)

The polling loop (`run_distillation_loop` / `zen_post_dpage`) re-distills repeatedly, autofilling inputs (mapped by `name` to form fields) and submitting when all expected fields are set, until a `gg-stop` pattern matches or timeout.

### dpage sign-in flow

When a tool is called and the user isn't signed in, `remote_zen_dpage_mcp_tool` returns `{url, signin_id, message}`. The client opens the URL in a browser, which renders `dpage/{id}` — a server-proxied form driven by distillation patterns. After sign-in completes (a pattern with `gg-stop` matches), `check_signin` returns SUCCESS and the original tool can be re-called to fetch data. `x-incognito: 1` header opens an ephemeral browser; `x-signin-id` header resumes a specific sign-in browser.

Browser identity: `browser_id` is derived from the auth user (`{sub}-{auth_provider}`) so each user has one persistent remote browser. Incognito browsers get an `E`-prefixed random ID.

### Tracing

`getgather/tracing.py` configures Logfire (if `LOGFIRE_TOKEN` set) and a custom `MCPSessionTraceMiddleware` that reparents per-request OTel spans under a session-root span keyed by `mcp-session-id`. The session ID doubles as the trace ID, so it can be pasted into Logfire. This middleware wraps the FastAPI app last so it runs before OTel's FastAPI instrumentation.

## Conventions

- Python 3.11+, pyright **strict** mode — avoid `Any` drift, annotate returns
- ruff lint selects `I, UP045, UP006, UP007` (isort + modern typing) with `line-length = 100`
- `mcp-tools.yaml` is intentionally excluded from yamlfix — edit it hand-formatted
- Pre-push hook runs `npm run check:all`; don't bypass with `--no-verify`
- Pattern files live beside patterns at `getgather/mcp/patterns/` — keep them minimal; they're parsed by BeautifulSoup, not rendered
- Settings via pydantic `BaseSettings` reads `.env`; see `.env.template` for keys
