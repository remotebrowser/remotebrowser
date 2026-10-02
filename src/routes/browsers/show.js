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
import { playwrightJavascriptDisplaySource, playwrightJavascriptSource } from './code-sample.js';

export const routes = new Hono();

// Same origin over websocket; http:/https: becomes ws:/wss:.
const cdpUrlFor = (c, browserHandle) => `${absoluteOrigin(c).replace(/^http/, 'ws')}/cdp/${browserHandle}`;

const renderBrowser = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const publicId = c.req.param('browserId');
  const result = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (result.error || !result.data) {
    return null;
  }
  // Handle presence isn't enough; status gates connection info.
  const isRunning = result.data.status === 'running';
  const handle = isRunning ? result.data.browserHandle : null;
  const cdpUrl = handle ? cdpUrlFor(c, handle) : null;
  const isConnectable = Boolean(cdpUrl);
  // No masked URL reaches the view: the code sample masks the whole CDP URL
  // on screen (see code-sample.js), so only fullJsSource - the Copy payload -
  // carries the real one.
  const fullJsSource = cdpUrl ? playwrightJavascriptSource(cdpUrl, handle) : null;
  // null for not-ready, unreachable, stopped; reverts preview too.
  let pages = null;
  if (isRunning && result.data.internalBrowserId) {
    const listed = await listBrowserPages({ browserId: result.data.internalBrowserId });
    if (listed.error) {
      consola.error('listBrowserPages failed:', listed.error);
    } else {
      // Page-level data needed: pageId/url/title per page, not just count.
      pages = listed.data.map((page) => ({ pageId: page.targetId, url: page.url, title: page.title }));
    }
  }
  return eta.render('browsers/show', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowsersBreadcrumbs(workspace, result.data.browserName),
    browser: result.data,
    // Only the creator (or an Admin/Owner) sees the Terminate control.
    canTerminate: canTerminateBrowser(result.data, workspace, user),
    // Gates the code sample and the preview column; the URL itself never
    // reaches the view.
    isConnectable,
    // Full value for clipboard copy (data-copy-value)
    fullJsSource,
    pages,
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    // GET /browsers/:browserId/pages (src/routes/browsers/pages/index.js).
    pagesUrl: `/browsers/${result.data.publicId}/pages`,
    // Public id, not the row's numeric key.
    browserUrl: `/browsers/${result.data.publicId}`,
    // ?t= freshens each <img> URL so browsers don't skip re-fetching.
    screenshotCacheBust: Math.floor(Date.now() / 1000),
    playwrightJavascriptExample: isConnectable ? playwrightJavascriptDisplaySource() : null
  });
};

const handleShow = async (c) => {
  const html = await renderBrowser(c);
  return html ? c.html(html) : c.text('Not found', 404);
};

routes.get('/:browserId', requireUser, requireWorkspaceRole('User'), handleShow);
