import { Hono } from 'hono';
import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import { requireWorkspaceRole, buildBreadcrumbs, loadWorkspaceSwitcherItems } from '../../middleware/workspace.js';
import { listBrowserInstancesByWorkspace } from '../../models/browsers.js';
import { STATUS_FILTERS, readStatusFilter, matchesStatusFilter, statusFilterQuery } from './status-filter.js';

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
  const statusFilter = readStatusFilter(c);
  const browsers = instances
    .filter((instance) => matchesStatusFilter(statusFilter, instance.status))
    .map(summarizeBrowserInstance);
  return eta.render('browsers/index', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBreadcrumbs(workspace, 'Browsers'),
    browsers,
    statusFilter,
    statusFilters: STATUS_FILTERS,
    statusQuery: statusFilterQuery(statusFilter),
    view: 'list',
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce')
  });
};

routes.get('/', requireUser, requireWorkspaceRole('User'), async (c) => c.html(await renderBrowsers(c)));
