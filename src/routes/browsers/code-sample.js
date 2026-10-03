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
// It leads both the display source and the copied source, so what the
// visitor sees and what they paste differ only in the masked CDP URL.
const INSTRUCTION_PREAMBLE = `Use the reference code below to write and run a Playwright script
that connects to this browser over CDP.  Navigate to Kagi News and
extract 7 random headlines.

Choose Node.js or Python, whichever is available. Work step by step:
after each step, inspect the page before moving on to the next one.`;

// Full source handed to the Copy button (data-copy-value); Eta escapes it.
// remote is composed from a handle variable so the credential stands out.
// A browser already has a page open; reuse it, don't open another.
// The fence is for the chat UI the instruction is pasted into: it makes
// that renderer treat the sample as code, not as prose.
// require, not import: a plain .js file is CommonJS unless the project opts
// into modules, and the pasted snippet must run there as-is.
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

const playwrightJavascriptDisplaySource = () => `${INSTRUCTION_PREAMBLE}

\`\`\`js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP(${MASKED_CDP_URL});
${browserExampleBody}
})();
\`\`\``;

export { playwrightJavascriptDisplaySource, playwrightJavascriptSource };
