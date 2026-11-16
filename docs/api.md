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

### Launch settings

To choose how the browser is set up, send a JSON body. Every setting is optional, and a setting you leave out takes its default. These are the same choices as in the web UI's launch form.

| Setting             | Values                                                                          | Default                          |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `name`              | Text, 1 to 80 characters                                                        | A random name, like `calm-otter` |
| `description`       | Text, up to 140 characters                                                      | Empty                            |
| `os`                | `debian-13`, `ubuntu-26.04`, `fedora-44`, `windows-11` (see [VM](vm.md))        | `debian-13`                      |
| `browser`           | `chromium`, `chrome` (Google Chrome)                                            | `chromium`                       |
| `screen_resolution` | `full-hd` (1920×1080), `wuxga` (1920×1200), `qhd` (2560×1440), `4k` (3840×2160) | `full-hd`                        |
| `screen_scale`      | `100`, `125`, `150`, `175`, `200` (percent, a number)                           | `150`                            |
| `webgl`             | `true` or `false`                                                               | `true`                           |
| `proxy`             | A proxy URL, or `null` to connect directly                                      | `null`                           |

_Example_, with several settings:

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "qa-run",
    "description": "For QA testing",
    "os": "ubuntu-26.04",
    "browser": "chrome",
    "screen_resolution": "qhd",
    "screen_scale": 100
  }' \
  http://localhost:3000/api/v1/browsers
```

Notes on some settings:

- **`os`**: Case does not matter, and the dash may be left out. `ubuntu`, `fedora`, and `windows` are short for `ubuntu-26.04`, `fedora-44`, and `windows-11`.
- **`browser`**: Case does not matter. `google-chrome` is short for `chrome`. A Windows browser runs Microsoft Edge either way.
- **`webgl`**: The VM has no GPU, so the browser draws WebGL on the CPU, with a software renderer (Mesa's llvmpipe). This is much slower than a real GPU. Set it to `false` if you do not need WebGL.
- **`proxy`**: The browser's traffic goes through this proxy. The URL starts with `http://`, `socks4://`, or `socks5://`; see [Proxy](proxy.md) for what it may hold. The proxy is set before the browser starts, so even its first request takes that route. It is the only setting you can [change later](#configure-a-browser).

The other settings apply only when the browser starts, so they cannot be changed later.

### Errors

| Status | Why                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | The body is not a JSON object, a setting is unknown, or a value is not allowed. The error says which.                                                      |
| 429    | The workspace launched too many browsers in the last minute. The `Retry-After` header says how many seconds to wait. The same limit applies to the web UI. |
| 429    | The server is already starting as many browsers as it can. The `Retry-After` header says how many seconds to wait.                                         |
| 503    | Browsers cannot be launched yet, or the chosen `os` is not ready yet. Try again in a few minutes.                                                          |

## Terminate a browser

`DELETE /api/v1/browsers/{browser_id}` terminates the browser. If the browser does not exist, the server returns HTTP 404. Only the person who launched the browser, or a workspace Admin, may terminate it; anyone else gets HTTP 403.

_Example_: `curl -X DELETE -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers/B5xqk2m` returns:

```json
{ "browser_id": "B5xqk2m", "status": "terminated" }
```

## Query a browser

`GET /api/v1/browsers/{browser_id}` returns the browser's ID, status, description, OS, and creation time. If the browser does not exist, the server returns HTTP 404.

_Example_: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/browsers/B5xqk2m` returns:

```json
{
  "browser_id": "B5xqk2m",
  "status": "running",
  "description": "For QA testing",
  "os": "debian-13",
  "creation_timestamp": 1793750400000
}
```

The status is one of `starting`, `running`, `suspended`, `error`, or `terminated`. The description is the one given at launch, or an empty string. The OS is the full name of the one it was launched on, such as `debian-13` or `windows-11`, even when the launch used a short name. The creation timestamp is the launch time, in milliseconds since the Unix epoch. It is `null` for a browser launched before the server kept it.

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
