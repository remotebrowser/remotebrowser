import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../render.js';
import { createCsrfToken } from '../auth/csrf.js';
import { requireUser } from '../middleware/auth.js';
import { requireWorkspaceRole, buildBreadcrumbs, loadWorkspaceSwitcherItems } from '../middleware/workspace.js';
import { listBrowserInstancesByWorkspace } from '../models/browsers.js';
import { countApiKeysByUser } from '../models/apikeys.js';
import { seesAllApiKeys, atApiKeyLimit } from './apikeys/index.js';

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
  // Only a count: the keys themselves are listed on /api-keys.
  const apiKeyCount = await countApiKeysByUser({ workspaceId: workspace.id, userId: user.id });
  if (apiKeyCount.error) {
    consola.error('API could not count the keys', { 'event.domain': 'api', 'error.type': String(apiKeyCount.error) });
  }
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
    // Null when the count failed, which leaves the sentence out.
    apiKeyCount: apiKeyCount.error ? null : apiKeyCount.data,
    // An Admin with no keys of their own has no link to /api-keys, so they get a button.
    canManageAllApiKeys: seesAllApiKeys(workspace),
    // Offered too when the count failed: the generate page checks again.
    canGenerateApiKey: Boolean(apiKeyCount.error) || !atApiKeyLimit(workspace, apiKeyCount.data)
  });
};

// Session workspace dashboard; requireUser guarantees the workspace exists.
routes.get('/', requireUser, requireWorkspaceRole('User'), async (c) => c.html(await renderDashboard(c)));
