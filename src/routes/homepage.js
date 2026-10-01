import { Hono } from 'hono';
import { eta } from '../render.js';
import { createCsrfToken } from '../auth/csrf.js';
import { requireUser } from '../middleware/auth.js';
import { requireWorkspaceRole, buildBreadcrumbs, loadWorkspaceSwitcherItems } from '../middleware/workspace.js';
import { listBrowserInstancesByWorkspace } from '../models/browsers.js';
import { scheduleBrowserStatusCheck, describeBrowserCapacity } from '../browser.js';

export const routes = new Hono();

// Dashboard shows only live browsers; the /browsers list covers stopped ones.
const CURRENT_STATUSES = new Set(['starting', 'running']);

const summarizeBrowserInstance = (instance) => ({
  browserInstanceId: instance.browserInstanceId,
  publicId: instance.publicId,
  browserName: instance.browserName,
  status: instance.status
});

const renderDashboard = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const listResult = await listBrowserInstancesByWorkspace({
    workspaceId: workspace.id,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  const instances = listResult.error ? [] : listResult.data;
  // Keep the workspace's 13s status check scheduled.
  scheduleBrowserStatusCheck({ workspaceId: workspace.id });
  const browsers = instances.filter((instance) => CURRENT_STATUSES.has(instance.status)).map(summarizeBrowserInstance);
  return eta.render('workspace/index', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBreadcrumbs(workspace),
    browsers,
    // Counts stopped browsers too, so 'Show all browsers' has a target.
    hasAnyBrowsers: instances.length > 0,
    // Capacity comes from the full list, since 'error' browsers occupy slots.
    capacity: describeBrowserCapacity({ workspace, instances })
  });
};

// Session workspace dashboard; requireUser guarantees the workspace exists.
routes.get('/', requireUser, requireWorkspaceRole('User'), async (c) => c.html(await renderDashboard(c)));
