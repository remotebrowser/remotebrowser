# Playground

The playground lets you try a script against a running browser, without setting anything up on your own machine. To open it, go to a running browser's page and follow the **playground** link.

On the left, you write a script and press **Run** (or Ctrl+Enter, ⌘+Enter on a Mac). On the right, you watch the browser do it. The script's `console` output, its return value, any errors, and any screenshots it takes appear under **Output**. **Stop** ends the script at once.

## Writing a script

A script is the body of an async function, so you can use `await` at the top level. These names are ready to use:

- `page`: the browser's first open tab
- `context`: `context.pages()` lists the open tabs, and `context.newPage()` opens another
- `browser`: `browser.newPage()` opens a tab, and `browser.close()` disconnects (the browser keeps running)
- `console`: `log`, `info`, `warn`, and `error` print to **Output**

The API follows [Playwright](https://playwright.dev), but it covers only the common calls:

- Navigation: `page.goto`, `page.reload`, `page.goBack`, `page.url`, `page.title`, `page.content`, `page.waitForURL`
- Actions: `page.click`, `page.fill`, `page.type`, `page.press`
- Reading: `page.evaluate`, `page.$eval`, `page.$$eval`, `page.textContent`, `page.innerText`
- Waiting: `page.waitForSelector`, `page.waitForTimeout`
- Locators: `page.locator(selector)`, with `first`, `last`, `nth`, `count`, `click`, `fill`, `press`, `textContent`, `innerText`, `allTextContents`, `getAttribute`, `isVisible`, and `waitFor`
- Tabs: `page.bringToFront`, `page.close`
- Screenshots: `page.screenshot()` shows the image under **Output**

Selectors are CSS selectors. For anything else, `page.cdp(method, params)` sends a raw [CDP](https://chromedevtools.github.io/devtools-protocol) command to the tab, and `browser.cdp(method, params)` sends one to the browser.

When the script works, move it to real Playwright with the instructions on the browser's page.

## Where the code runs

The script runs in a [web worker](https://developer.mozilla.org/docs/Web/API/Web_Workers_API) in your own browser tab, not on the Remote Browser server. The worker connects to the browser over the same CDP URL that the browser's page shows you.

The worker has its own Content Security Policy. It may evaluate code, but the only network connection it may open is a websocket to the CDP relay (`/cdp/`). It cannot call the app's own pages or any other site, and it cannot read or change the playground page.

Like the CDP URL itself, a script gets full control of the browser. Run only code you trust.
