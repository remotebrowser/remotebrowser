# Playground

![Playground](playground.jpg){: style="width: 505px; max-width: 100%; height: auto; border: 1px solid darkgray" }

The playground lets you try a script against a running browser, without setting anything up on your own machine. It sits on the browser's own page, with the live previews of the browser's pages beside it. While the browser starts or is suspended, the playground shows dimmed, and it works once the browser runs. It needs JavaScript, so it does not show when JavaScript is off.

Pick a ready-made script from the list, or write your own, and press **Run** (or Ctrl+Enter, ⌘+Enter on a Mac) to watch the browser carry it out in the previews. Click a preview to open that page on its own. The script's `console` output, its return value, any errors, and any screenshots it takes appear in an output box under the previews once the script ends, with how long it took. Your script is kept in your browser, so it is still there when you come back to the page. While the script runs, the **Run** button turns into **Stop**, which ends the script at once.

## Writing a script

A script is the body of an async function, so you can use `await` at the top level. These names are ready to use:

- `page`: the browser's first open tab
- `console`: `log`, `info`, `warn`, and `error` print to the output

The page object is a small helper API inspired by [Playwright](https://playwright.dev):

- Navigation: `page.goto`, `page.url`, `page.title`, `page.content`
- Actions: `page.click`, `page.fill`, `page.press`
- Reading: `page.evaluate`, `page.$eval`, `page.$$eval`, `page.textContent`, `page.innerText`
- Waiting: `page.waitForSelector`, `page.waitForTimeout`
- Screenshots: `page.screenshot()` shows the image in the output

Selectors are CSS selectors. For anything else, `page.cdp(method, params)` sends a raw [CDP](https://chromedevtools.github.io/devtools-protocol) command to the tab.

## Where the code runs

The script runs in a [web worker](https://developer.mozilla.org/docs/Web/API/Web_Workers_API) in your own browser tab, not on the Remote Browser server. The worker connects to the browser over the same CDP URL that the coding assistant instructions carry.

The worker has its own Content Security Policy. It may evaluate code, but the only network connection it may open is a websocket to the CDP relay (`/cdp/`). It cannot call the app's own pages or any other site, and it cannot read or change the browser's page that hosts it.

Like the CDP URL itself, a script gets full control of the browser. Run only code you trust.
