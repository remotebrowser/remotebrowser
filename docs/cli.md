# CLI

`remotebrowser` is a command-line tool for managing browsers.

It requires two environment variables: `REMOTEBROWSER_API_KEY` for your API key, and `REMOTEBROWSER_URL` for the server URL.

## Install

Download a prebuilt binary for Windows, macOS, Linux, or FreeBSD from the [releases page](https://github.com/remotebrowser/cli/releases).

For example, on Linux x86_64:

```bash
VERSION=0.2.0
NAME=remotebrowser-$VERSION-linux-x86_64
curl -LO https://github.com/remotebrowser/cli/releases/download/v$VERSION/$NAME.tar.gz
tar -xzf $NAME.tar.gz
sudo install $NAME/remotebrowser /usr/local/bin/
```

## Example

Set your API key and the server URL:

```bash
export REMOTEBROWSER_API_KEY=sk-rb-v1-...
export REMOTEBROWSER_URL=http://localhost:3000
```

Launch a browser. With `--wait`, the command blocks until the browser is running, then prints its ID:

```bash
ID=$(remotebrowser create --browser chrome --wait)
```

List the active browsers:

```bash
remotebrowser list
```

Print the [CDP](https://chromedevtools.github.io/devtools-protocol/) WebSocket URL, for example `ws://localhost:3000/api/v1/browsers/B5xqk2m/cdp`:

```bash
remotebrowser connect $ID
```

To use this with [Playwright](https://playwright.dev/), send the API key in the `Authorization: Bearer` header, as described in [Connect to a browser over CDP](api.md#connect-to-a-browser-over-cdp).

When you are done, terminate the browser:

```bash
remotebrowser delete $ID
```

For all the commands and options, see the [README](https://github.com/remotebrowser/cli#readme), or run `remotebrowser --help`.
