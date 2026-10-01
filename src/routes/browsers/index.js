import { Hono } from 'hono';
import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import { requireWorkspaceRole, buildBreadcrumbs, loadWorkspaceSwitcherItems } from '../../middleware/workspace.js';
import { listBrowserInstancesByWorkspace } from '../../models/browsers.js';
import { scheduleBrowserStatusCheck, describeBrowserCapacity } from '../../browser.js';

export const routes = new Hono();

const summarizeBrowserInstance = (instance) => ({
  browserInstanceId: instance.browserInstanceId,
  publicId: instance.publicId,
  browserName: instance.browserName,
  status: instance.status
});

const renderBrowsers = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const listResult = await listBrowserInstancesByWorkspace({
    workspaceId: workspace.id,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  const instances = listResult.error ? [] : listResult.data;
  // Keep the workspace's 13s status check scheduled.
  scheduleBrowserStatusCheck({ workspaceId: workspace.id });
  const browsers = instances.map(summarizeBrowserInstance);
  return eta.render('browsers/index', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBreadcrumbs(workspace, 'Browsers'),
    browsers,
    capacity: describeBrowserCapacity({ workspace, instances })
  });
};

routes.get('/', requireUser, requireWorkspaceRole('User'), async (c) => c.html(await renderBrowsers(c)));
