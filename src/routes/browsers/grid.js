import { Hono } from 'hono';
import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  buildBrowsersBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../middleware/workspace.js';
import { listBrowserInstancesByWorkspace } from '../../models/browsers.js';
import { describeBrowserCapacity } from '../../browser.js';

export const routes = new Hono();

// Only a running browser has pages to show.
const summarizeBrowserInstance = (instance) => ({
  publicId: instance.publicId,
  browserName: instance.browserName,
  status: instance.status,
  hasThumbnail: instance.status === 'running' && Boolean(instance.internalBrowserId)
});

const renderGrid = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const listResult = await listBrowserInstancesByWorkspace({
    workspaceId: workspace.id,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  const instances = listResult.error ? [] : listResult.data;
  return eta.render('browsers/grid', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowsersBreadcrumbs(workspace, 'Grid'),
    view: 'grid',
    browsers: instances.map(summarizeBrowserInstance),
    capacity: describeBrowserCapacity({ workspace, instances }),
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    // A new value every poll so the browser reloads the thumbnail.
    screenshotCacheBust: Math.floor(Date.now() / 1000)
  });
};

routes.get('/grid', requireUser, requireWorkspaceRole('User'), async (c) => c.html(await renderGrid(c)));
