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
import { canSuspendBrowsers, listSuspendedPreviews } from '../../fleet.js';
import { INSTRUCTION_PREAMBLE, fullInstructionSource, playwrightJavascriptDisplaySource } from './code-sample.js';

export const routes = new Hono();

// Same origin over websocket; http:/https: becomes ws:/wss:.
export const cdpUrlFor = (c, browserHandle) => `${absoluteOrigin(c).replace(/^http/, 'ws')}/cdp/${browserHandle}`;

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

// What the status bar (views/browsers/status-bar.eta.html) needs, so any page
// about one browser can show its status and the controls that act on it.
export const statusBarData = (c, browser) => {
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
    canSuspend: canTerminate && canSuspendBrowsers(),
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
    pages,
    suspendedPages: await listSuspendedPages(browser),
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    // GET /browsers/:browserId/pages (src/routes/browsers/pages/index.js).
    pagesUrl: `/browsers/${browser.publicId}/pages`,
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

// The one poll on a browser's page, so it skips the rest of the page. It always
// answers with the status line. With ?preview=1 it also brings the previews,
// picking up opened and closed pages, and when the status has changed, the
// controls that act on it; the status line swaps both out of band, by id
// (status.eta.html). Only htmx asks for it, so the
// previews always stream.
routes.get('/:browserId/status', requireUser, requireWorkspaceRole('User'), async (c) => {
  const browser = await findBrowser(c);
  if (!browser) {
    return c.text('Not found', 404);
  }
  const withPreview = c.req.query('preview') === '1';
  // The browser page asks for the previews, and it has Resume in its details
  // column; the playground does not, so it keeps the controls in its status bar.
  const data = { ...statusBarData(c, browser), suspendedControls: !withPreview };
  let html = eta.render('browsers/status', { ...data, withPreview, live: true });
  if (withPreview) {
    html += eta.render('browsers/preview', {
      ...data,
      pages: await listPreviewPages(browser),
      suspendedPages: await listSuspendedPages(browser),
      live: true
    });
  }
  const shown = c.req.query('shown');
  if (shown && shown !== browser.status) {
    html += eta.render('browsers/actions', data);
    // htmx fires it on the page, which then refreshes the other parts that
    // depend on the status.
    c.header('HX-Trigger', 'browser-status-changed');
  }
  return c.html(html);
});

export { renderBrowser };
