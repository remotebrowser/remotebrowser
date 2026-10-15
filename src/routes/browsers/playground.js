import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  buildBrowserPlaygroundBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../middleware/workspace.js';
import { getBrowserInstanceByPublicId } from '../../models/browsers.js';
import { listBrowserPages } from '../../cdp.js';
import { cdpUrlFor } from './show.js';

export const routes = new Hono();

// Starting points for the editor. The code runs in the visitor's own tab
// (public/playground-worker.js), not on this server.
const PLAYGROUND_TEMPLATES = [
  {
    key: 'title',
    label: 'Get the page title',
    code: `await page.goto('https://example.com');
console.log('Title:', await page.title());
console.log('URL:', page.url());`
  },
  {
    key: 'headlines',
    label: 'Extract headlines',
    code: `await page.goto('https://news.ycombinator.com');
const headlines = await page.locator('.titleline > a').allTextContents();
console.log(headlines.slice(0, 7));`
  },
  {
    key: 'search',
    label: 'Fill and submit a form',
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
    key: 'screenshot',
    label: 'Take a screenshot',
    code: `await page.goto('https://remotebrowser.ai');
await page.screenshot();`
  },
  {
    key: 'tabs',
    label: 'Open a new tab',
    code: `const tab = await browser.newPage();
await tab.goto('https://example.org');
console.log('Open pages:', context.pages().map((p) => p.url()));
await tab.close();`
  },
  {
    key: 'cdp',
    label: 'Send a raw CDP command',
    code: `const { result } = await page.cdp('Runtime.evaluate', {
  expression: 'navigator.userAgent',
  returnByValue: true
});
console.log(result.value);`
  }
];

const renderPlayground = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const result = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (result.error || !result.data) {
    return null;
  }
  const browser = result.data;
  // Same gate as the show page: only a running browser hands out its CDP URL.
  const isRunning = browser.status === 'running' && Boolean(browser.browserHandle);
  const pagesUrl = `/browsers/${browser.publicId}/pages`;
  let frameUrl = null;
  if (isRunning && browser.internalBrowserId) {
    const listed = await listBrowserPages({ browserId: browser.internalBrowserId });
    if (listed.error) {
      consola.error('listBrowserPages failed:', listed.error);
    } else if (listed.data.length > 0) {
      frameUrl = `${pagesUrl}/${listed.data[0].targetId}/frame`;
    }
  }
  return eta.render('browsers/playground', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowserPlaygroundBreadcrumbs(workspace, browser.publicId, browser.browserName),
    browser,
    isRunning,
    // Only the worker reads it; anyone who sees this page may already copy it
    // from the browser's own page.
    cdpUrl: isRunning ? cdpUrlFor(c, browser.browserHandle) : null,
    pagesUrl,
    frameUrl,
    templates: PLAYGROUND_TEMPLATES,
    bodyClass: 'wide'
  });
};

routes.get('/:browserId/playground', requireUser, requireWorkspaceRole('User'), async (c) => {
  const html = await renderPlayground(c);
  return html ? c.html(html) : c.text('Not found', 404);
});

export { PLAYGROUND_TEMPLATES };
