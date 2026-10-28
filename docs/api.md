# API

The REST API lets a program launch, list, query, suspend, resume, and terminate browsers, and drive them over [CDP](https://chromedevtools.github.io/devtools-protocol).

## API keys

Every call needs an API key, sent as a Bearer token:

```
Authorization: Bearer sk-rb-v1-...
```

To create a key, open the workspace page and click **Generate a new API key**. Give it a name and choose when it expires: in 1 hour, 1 day, 7 days, 30 days, or 90 days. The key is shown only once, so copy it right away. Remote Browser stores only a digest of the key, so it cannot show the key again.

A key belongs to the workspace where it was created, and it can only reach the browsers in that workspace. It acts with the rights of the person who created it. If that person leaves the workspace, or is removed from it, their keys for that workspace are deleted.

The workspace's Admins and Owners can see every member's keys on the API keys page, and delete any of them, for example one that leaked. Anyone else sees only their own keys. Expired keys are deleted automatically.

Each person can have only so many valid API keys in a workspace. To make a new one beyond that, delete one first.

A call with a missing, wrong, or expired key gets HTTP 401.

## Launch a browser

`POST /api/v1/browsers` launches a new browser in the key's workspace and returns its `browser_id`. The browser is still starting when the call returns.

_Example_:

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers
```

returns:

```json
{ "browser_id": "B5xqk2m", "status": "launched" }
```

If browsers cannot be launched yet, the server returns HTTP 503.

A workspace can launch only so many browsers a minute. A launch over that rate gets HTTP 429, and the `Retry-After` header says how many seconds to wait. The same limit applies to the web UI.

The request can carry a JSON body with the browser's [settings](#configure-a-browser), for example to launch it behind a proxy. The proxy is set before the browser starts, so even its first request takes that route:

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{ "proxy": "http://user:password@proxy.example.com:8080" }' http://localhost:3000/api/v1/browsers
```

## Terminate a browser

`DELETE /api/v1/browsers/{browser_id}` terminates the browser. If the browser does not exist, the server returns HTTP 404. Only the person who launched the browser, or a workspace Admin, may terminate it; anyone else gets HTTP 403.

_Example_: `curl -X DELETE -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers/B5xqk2m` returns:

```json
{ "browser_id": "B5xqk2m", "status": "terminated" }
```

## Query a browser

`GET /api/v1/browsers/{browser_id}` returns the browser's ID, status, and description. If the browser does not exist, the server returns HTTP 404.

_Example_: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers/B5xqk2m` returns:

```json
{ "browser_id": "B5xqk2m", "status": "running", "description": "For QA testing" }
```

The status is one of `starting`, `running`, `suspended`, `error`, or `terminated`. The description is the one given at launch in the web UI, or an empty string.

## Suspend a browser

`POST /api/v1/browsers/{browser_id}/suspend` suspends a running browser: it saves the browser's state and stops it, so that it can be resumed later where it left off.

_Example_: `curl -X POST -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers/B5xqk2m/suspend` returns:

```json
{ "browser_id": "B5xqk2m", "status": "suspended" }
```

## Resume a browser

`POST /api/v1/browsers/{browser_id}/resume` resumes a suspended browser.

_Example_: `curl -X POST -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers/B5xqk2m/resume` returns:

```json
{ "browser_id": "B5xqk2m", "status": "running" }
```

For both calls, the same people may act as for terminating: the person who launched the browser, or a workspace Admin. A browser that is not in the right state (for example, resuming one that is already running) gets HTTP 409, with its `browser_id` and current `status`.

## Configure a browser

`GET /api/v1/browsers/{browser_id}/config` returns the browser's settings, and `PATCH /api/v1/browsers/{browser_id}/config` changes them. A setting that the `PATCH` body leaves out stays as it is.

_Example_:

```bash
curl -X PATCH -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{ "proxy": "http://user:password@proxy.example.com:8080" }' \
  http://localhost:3000/api/v1/browsers/B5xqk2m/config
```

returns:

```json
{ "browser_id": "B5xqk2m", "proxy": "http://user:****@proxy.example.com:8080" }
```

The only setting for now is `proxy`, the upstream proxy that the browser's traffic goes through. The URL starts with `http://`, `socks4://`, or `socks5://`; see [Proxy](proxy.md) for what it may hold. Set it to `null` to connect directly again. The password is never shown back.

Changing the proxy ends the browser's open connections, so none of them keep the old route, and requests in flight at that moment fail. The call returns once the new proxy is in use.

Only a running browser can be configured; any other gets HTTP 409, with its `browser_id` and current `status`. The same people may configure a browser as may terminate it. A setting that is unknown, or a proxy URL that is not valid, gets HTTP 400.

## List all browsers

`GET /api/v1/browsers` returns the IDs of the starting and running browsers in the key's workspace.

_Example_: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers` returns:

```json
["B5xqk2m", "Babc234"]
```

## Connect to a browser over CDP

`GET /api/v1/browsers/{browser_id}/cdp` upgrades the connection to a WebSocket and tunnels a [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol) (CDP) session to the browser. The API key goes in the `Authorization` header of the upgrade request. If the browser cannot be reached, the server accepts the WebSocket and then closes it with close code 4502.

An open session keeps checking its API key. If the key is deleted or expires, or its creator leaves the workspace, the server closes the session with close code 4401. This happens at once when the change is made on the same server, and otherwise within a minute.

_Example (Playwright with Node.js)_:

```js
import { chromium } from 'playwright';

const target = 'ws://localhost:3000/api/v1/browsers/B5xqk2m/cdp';
const browser = await chromium.connectOverCDP(target, {
  headers: { Authorization: `Bearer ${process.env.API_KEY}` }
});
const [context] = browser.contexts();
const page = await context.newPage();
await page.goto('https://example.com');
await browser.close();
```
