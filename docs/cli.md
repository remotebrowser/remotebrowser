# CLI

`remotebrowser` is a command-line tool for managing browsers.

## Install

On Linux, macOS, or FreeBSD:

```bash
curl -fsSL https://remotebrowser.ai/install.sh | bash
```

The script installs `remotebrowser` to `~/.local/bin`.

Set `REMOTEBROWSER_INSTALL_DIR` to install elsewhere, or `REMOTEBROWSER_VERSION` (such as `0.2.0`) to install a specific version.

Or download a prebuilt binary for Windows, macOS, Linux, or FreeBSD from the [releases page](https://github.com/remotebrowser/cli/releases). For example, on Linux x86_64:

```bash
VERSION=0.2.0
NAME=remotebrowser-$VERSION-linux-x86_64
curl -LO https://github.com/remotebrowser/cli/releases/download/v$VERSION/$NAME.tar.gz
tar -xzf $NAME.tar.gz
sudo install $NAME/remotebrowser /usr/local/bin/
```

## Usage

Start with `remotebrowser login <URL>`, where `<URL>` is the server URL. For example:

```bash
remotebrowser login http://localhost:3000
```

This opens your web browser and shows a code. Check that the code matches the one in the terminal, then approve it. If you belong to several workspaces, choose the one the CLI may use. The CLI then stays logged in for 30 days.

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

To use this with [Playwright](https://playwright.dev/), see [Connect to a browser over CDP](api.md#connect-to-a-browser-over-cdp).

When you are done, terminate the browser:

```bash
remotebrowser delete $ID
```

For all the commands and options, see the [README](https://github.com/remotebrowser/cli#readme), or run `remotebrowser --help`.
