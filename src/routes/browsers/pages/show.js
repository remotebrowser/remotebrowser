import { Hono } from 'hono';
import { eta } from '../../../render.js';
import { createCsrfToken } from '../../../auth/csrf.js';
import { requireUser } from '../../../middleware/auth.js';
import {
  requireWorkspaceRole,
  buildBrowserPageBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../../middleware/workspace.js';
import { getBrowserInstanceByPublicId } from '../../../models/browsers.js';

export const routes = new Hono();

// Shared with live.js, which needs the same data for a different template.
export const renderPage = async (c, template = 'browsers/pages/show') => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const publicId = c.req.param('browserId');
  const pageId = c.req.param('pageId');
  const result = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (result.error || !result.data) {
    return null;
  }
  return eta.render(template, {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowserPageBreadcrumbs(workspace, result.data.publicId, result.data.browserName, pageId),
    browser: result.data,
    pageId,
    // Mirrors cdpUrl gating: a stale pageId simply renders a broken image.
    pageViewUrl: result.data.internalBrowserId ? `/browsers/${result.data.publicId}/pages/${pageId}/view` : null,
    pageLiveUrl: result.data.internalBrowserId ? `/browsers/${result.data.publicId}/pages/${pageId}/live` : null,
    pageFrameUrl: result.data.internalBrowserId ? `/browsers/${result.data.publicId}/pages/${pageId}/frame` : null
  });
};

const handleShow = async (c) => {
  const html = await renderPage(c);
  return html ? c.html(html) : c.text('Not found', 404);
};

routes.get('/:browserId/pages/:pageId', requireUser, requireWorkspaceRole('User'), handleShow);
