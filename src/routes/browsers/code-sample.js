// cdpUrl ends with the handle; slicing it off leaves the relay origin/path.
const cdpOriginFor = (cdpUrl, handle) => cdpUrl.slice(0, cdpUrl.length - handle.length);

// The tail the copied and the displayed source share; only the line that
// reaches the browser differs - cdpOriginFor(...) there, MASKED_CDP_URL here.
// Keeping it in one place is what keeps the two sources aligned.
const browserExampleBody = `  const [context] = browser.contexts();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await page.goto('https://google.com');
  await browser.close();`;

// The block is an instruction first and a code sample second: the prose
// preamble tells the coding assistant what to do, the JS below shows how.
// The page shows the two apart - a flowing paragraph and a <pre> - while the
// copied source joins them back into one block, so what the visitor reads and
// what they paste differ only in the masked CDP URL.
const INSTRUCTION_PREAMBLE = `Use the reference code below to write and run a Playwright script
that connects to this browser over CDP.  Navigate to Kagi News and
extract 7 random headlines.

Choose Node.js or Python, whichever is available. Work step by step:
after each step, inspect the page before moving on to the next one.`;

// The fence is for the chat UI the instruction is pasted into: it makes that
// renderer treat the sample as code, not as prose.
// require, not import: a plain .js file is CommonJS unless the project opts
// into modules, and the pasted snippet must run there as-is.
// remote is composed from a handle variable so the credential stands out.
// A browser already has a page open; reuse it, don't open another.
const playwrightJavascriptSource = (cdpUrl, handle) => `${INSTRUCTION_PREAMBLE}

\`\`\`js
const { chromium } = require('playwright');

(async () => {
  const handle = '${handle}';
  const remote = \`${cdpOriginFor(cdpUrl, handle)}\${handle}\`;
  const browser = await chromium.connectOverCDP(remote);
${browserExampleBody}
})();
\`\`\``;

// What's shown on screen hides the whole CDP URL - neither the relay origin
// nor the handle - so only the copied source above carries the credential.
const MASKED_CDP_URL = '*************';

// Full value handed to the Copy button (data-copy-value); Eta escapes it.
// The masked display source above is only for the visible <pre>; the copy
// payload keeps the real handle so it still carries the credential.
const fullInstructionSource = (cdpUrl, handle) => playwrightJavascriptSource(cdpUrl, handle);

// Just the JS sample for the <pre> the page lays out as code. No fence here:
// the page shows the fence as a visually-hidden line (views/browsers/
// show.eta.html) so it stays in the copied payload without cluttering the
// on-screen block.
const playwrightJavascriptDisplaySource = () => `const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP(${MASKED_CDP_URL});
${browserExampleBody}
})();`;

export { INSTRUCTION_PREAMBLE, playwrightJavascriptDisplaySource, fullInstructionSource, playwrightJavascriptSource };
