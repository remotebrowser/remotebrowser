import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  buildBrowsersBreadcrumbs,
  loadWorkspaceSwitcherItems,
  canTerminateBrowser
} from '../../middleware/workspace.js';
import { getBrowserInstanceByPublicId } from '../../models/browsers.js';
import { absoluteOrigin } from '../../origin.js';
import { listBrowserPages } from '../../cdp.js';
import { listSuspendedPreviews } from '../../vms.js';
import { INSTRUCTION_PREAMBLE, fullInstructionSource, playwrightJavascriptDisplaySource } from './code-sample.js';
import { isLlmWorking } from '../../llm/harness.js';

export const routes = new Hono();

// Starting points for the editor. The code runs in the visitor's own tab
// (public/playground-worker.js), not on this server. While the LLM works, the
// list offers the task in natural language instead (src/llm/harness.js). Raw CDP
// has none, since the LLM may not use page.cdp, so it stays as code.
const PLAYGROUND_TEMPLATES = [
  {
    key: 'title',
    label: 'Get the page title',
    text: 'Go to phys.org and print the page title',
    code: `await page.goto('https://phys.org');
console.log('Title:', await page.title());`
  },
  {
    key: 'headlines',
    label: 'Extract headlines',
    text: 'Print the first 7 headlines from text.npr.org',
    code: `await page.goto('https://text.npr.org/');
const headlines = await page.$$eval('.topic-container a.topic-title', (links) =>
  links.map((link) => link.textContent.trim())
);
headlines.slice(0, 7).map((headline, index) => console.log(\`\${index + 1}. \${headline}\`));`
  },
  {
    key: 'search',
    label: 'Fill and submit a form',
    text: 'Search Wikipedia for "headless browser" and show the top 5 results',
    code: `await page.goto('https://en.wikipedia.org/wiki/Special:Search');
await page.fill('#ooui-php-1', 'headless browser');
await page.press('#ooui-php-1', 'Enter');
await page.waitForSelector('.mw-search-result-heading a');
const results = await page.$$eval('.mw-search-result-heading a', (links) =>
  links.slice(0, 5).map((link) => ({ title: link.textContent, href: link.href }))
);
console.log(results);`
  },
  {
    key: 'cdp',
    label: 'Send a raw CDP command',
    code: `const { result } = await page.cdp('Runtime.evaluate', {
  expression: 'navigator.userAgent',
  returnByValue: true
});
console.log(result.value);`
  },
  {
    key: 'custom',
    label: 'Custom task',
    text: 'Navigate to Google',
    code: `await page.goto('https://www.google.com');`
  }
];

// Same origin over websocket; http:/https: becomes ws:/wss:.
const cdpUrlFor = (c, browserHandle) => `${absoluteOrigin(c).replace(/^http/, 'ws')}/cdp/${browserHandle}`;

const findBrowser = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const result = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  return result.error ? null : result.data;
};

// null for not-ready, unreachable, stopped; reverts preview too.
const listPreviewPages = async (browser) => {
  if (browser.status !== 'running' || !browser.internalBrowserId) {
    return null;
  }
  const listed = await listBrowserPages({ browserId: browser.internalBrowserId });
  if (listed.error) {
    consola.error('listBrowserPages failed:', listed.error);
    return null;
  }
  // Page-level data needed: pageId/url/title per page, not just count.
  return listed.data.map((page) => ({ pageId: page.targetId, url: page.url, title: page.title }));
};

// The pages a suspended browser had, each with a picture saved at suspend
// time; none otherwise.
const listSuspendedPages = async (browser) =>
  browser.status === 'suspended' && browser.internalBrowserId
    ? listSuspendedPreviews({ browserId: browser.internalBrowserId })
    : [];

// What the status bar (views/browsers/status-bar.eta.html) needs.
const statusBarData = (c, browser) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  // Only the creator (or an Admin/Owner) sees the Terminate, Suspend, and
  // Resume controls.
  const canTerminate = canTerminateBrowser(browser, workspace, user);
  return {
    browser,
    workspace,
    csrfToken: createCsrfToken(c),
    canTerminate,
    // Handle presence isn't enough; status gates the controls too.
    isConnectable: browser.status === 'running' && Boolean(browser.browserHandle),
    statusUrl: `/browsers/${browser.publicId}/status`
  };
};

// `error` reports a failed action on this page, such as a resume.
const renderBrowser = async (c, { error = null } = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const browser = await findBrowser(c);
  if (!browser) {
    return null;
  }
  // Handle presence isn't enough; status gates connection info.
  const isRunning = browser.status === 'running';
  const handle = isRunning ? browser.browserHandle : null;
  const cdpUrl = handle ? cdpUrlFor(c, handle) : null;
  const isConnectable = Boolean(cdpUrl);
  // No masked URL reaches the visible blocks: the code sample masks the whole
  // CDP URL on screen (see code-sample.js), so only fullInstruction - the Copy
  // payload - carries the real one.
  const fullInstruction = cdpUrl ? fullInstructionSource(cdpUrl, handle) : null;
  const pages = await listPreviewPages(browser);
  // Read once, so the preamble and the examples agree.
  const naturalLanguage = isLlmWorking();
  return eta.render('browsers/show', {
    ...statusBarData(c, browser),
    email: user.email,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowsersBreadcrumbs(workspace, browser.browserName),
    error,
    // Gates the code sample and the preview column; the URL itself never
    // reaches the view.
    isConnectable,
    // Full value for clipboard copy (data-copy-value)
    fullInstruction,
    // Prose preamble the page lays out as a flowing paragraph; the fenced code
    // itself is playwrightJavascriptExample below.
    instructionPreamble: isConnectable ? INSTRUCTION_PREAMBLE : null,
    // Only the playground's worker reads it; the Copy payload above has it too.
    cdpUrl,
    naturalLanguage,
    templates: PLAYGROUND_TEMPLATES.map(({ key, label, text, code }) => ({
      key,
      label,
      example: naturalLanguage && text ? text : code
    })),
    pages,
    suspendedPages: await listSuspendedPages(browser),
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    // GET /browsers/:browserId/pages (src/routes/browsers/pages/index.js).
    pagesUrl: `/browsers/${browser.publicId}/pages`,
    // POST /browsers/:browserId/harness (src/routes/browsers/harness.js).
    harnessUrl: `/browsers/${browser.publicId}/harness`,
    // ?t= freshens each <img> URL so browsers don't skip re-fetching.
    screenshotCacheBust: Math.floor(Date.now() / 1000),
    // Only htmx asks with this header, so JavaScript is on and the previews
    // can stream; the first load keeps static screenshots for no-JS visitors.
    live: c.req.header('HX-Request') === 'true',
    playwrightJavascriptExample: isConnectable ? playwrightJavascriptDisplaySource() : null
  });
};

const handleShow = async (c) => {
  const html = await renderBrowser(c);
  // The previews differ for htmx requests, so caches must keep both.
  c.header('Vary', 'HX-Request');
  return html ? c.html(html) : c.text('Not found', 404);
};

routes.get('/:browserId', requireUser, requireWorkspaceRole('User'), handleShow);

// The one poll on a browser's page, so it skips the rest of the page. It
// answers with the status line and the previews, picking up opened and closed
// pages, and when the status has changed, the controls that act on it; the
// status line swaps both out of band, by id (status.eta.html). Only htmx asks
// for it, so the previews always stream.
routes.get('/:browserId/status', requireUser, requireWorkspaceRole('User'), async (c) => {
  const browser = await findBrowser(c);
  if (!browser) {
    return c.text('Not found', 404);
  }
  const data = statusBarData(c, browser);
  let html = eta.render('browsers/status', { ...data, live: true });
  html += eta.render('browsers/preview', {
    ...data,
    pages: await listPreviewPages(browser),
    suspendedPages: await listSuspendedPages(browser),
    live: true
  });
  const shown = c.req.query('shown');
  if (shown && shown !== browser.status) {
    html += eta.render('browsers/actions', data);
    // htmx fires it on the page, which then refreshes the other parts that
    // depend on the status.
    c.header('HX-Trigger', 'browser-status-changed');
  }
  return c.html(html);
});

export { renderBrowser, PLAYGROUND_TEMPLATES };
