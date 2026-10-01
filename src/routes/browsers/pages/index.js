import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../../render.js';
import { createCsrfToken } from '../../../auth/csrf.js';
import { requireUser } from '../../../middleware/auth.js';
import {
  requireWorkspaceRole,
  buildBrowserPagesBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../../middleware/workspace.js';
import { getBrowserInstanceByPublicId } from '../../../models/browsers.js';
import { listBrowserPages } from '../../../cdp.js';

export const routes = new Hono();

const renderPages = async (c) => {
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
  // null means 'not ready' or 'CDP unreachable', like the browser page count.
  let pages = null;
  if (result.data.internalBrowserId) {
    const listed = await listBrowserPages({ browserId: result.data.internalBrowserId });
    if (listed.error) {
      consola.error('listBrowserPages failed:', listed.error);
    } else {
      // getTargets already supplies title/url; rename targetId to pageId.
      pages = listed.data.map((page) => ({ pageId: page.targetId, url: page.url, title: page.title }));
    }
  }
  return eta.render('browsers/pages/index', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowserPagesBreadcrumbs(workspace, result.data.publicId, result.data.browserName),
    browser: result.data,
    pages,
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    // Appended as a query param to every screenshot <img> src, to vary the URL
    // per poll.
    screenshotCacheBust: Math.floor(Date.now() / 1000)
  });
};

const handleIndex = async (c) => {
  const html = await renderPages(c);
  return html ? c.html(html) : c.text('Not found', 404);
};

routes.get('/:browserId/pages', requireUser, requireWorkspaceRole('User'), handleIndex);
