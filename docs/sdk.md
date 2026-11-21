# SDK

The SDKs wrap the [REST API](api.md), so a program can manage browsers without making raw HTTP calls.

Every SDK is configured through two environment variables:

- `REMOTEBROWSER_API_KEY`: an API key from the workspace page (see [API keys](api.md#api-keys))
- `REMOTEBROWSER_URL`: the URL of the Remote Browser server

## Node.js

Requires [Node.js](https://nodejs.org) 22 or later.

```bash
npm install @remotebrowser/sdk
```

```js
import RemoteBrowser from '@remotebrowser/sdk';

const client = new RemoteBrowser();
const { browser_id } = await client.browsers.create({ browser: 'chrome' });
const cdpUrl = client.browsers.connectUrl(browser_id);
```

The [CDP](https://chromedevtools.github.io/devtools-protocol/) URL needs the API key in the `Authorization: Bearer` header. Pass `client.authHeaders` as the headers when you connect, for example with [Playwright](https://playwright.dev)'s `connectOverCDP`.

To try it quickly from the command line:

```bash
npx @remotebrowser/sdk create --browser chrome
```

See the repository for the full API, the command-line tool, error handling, and retries.

- Package: [@remotebrowser/sdk](https://www.npmjs.com/package/@remotebrowser/sdk)
- Repository: [remotebrowser/sdk-nodejs](https://github.com/remotebrowser/sdk-nodejs)

## Python

Requires [Python](https://www.python.org) 3.11 or later.

```bash
pip install remotebrowser    # with pip
uv add remotebrowser         # with uv
```

```python
from remotebrowser import RemoteBrowser

client = RemoteBrowser()
browser_id = client.browsers.create(browser="chrome")["browser_id"]
cdp_url = client.browsers.connect_url(browser_id)
```

The [CDP](https://chromedevtools.github.io/devtools-protocol/) URL needs the API key in the `Authorization: Bearer` header. Pass `client.auth_headers` as the headers when you connect, for example with [Playwright](https://playwright.dev/python/)'s `connect_over_cdp`.

To try it quickly from the command line:

```bash
pipx run remotebrowser create --browser chrome    # with pipx
uvx remotebrowser create --browser chrome         # with uv
```

See the repository for the full API, the command-line tool, error handling, and retries.

- Package: [remotebrowser](https://pypi.org/project/remotebrowser/)
- Repository: [remotebrowser/sdk-python](https://github.com/remotebrowser/sdk-python)
