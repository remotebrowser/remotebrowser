import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSubmittedWorkspace,
  buildApiKeysBreadcrumbs,
  loadWorkspaceSwitcherItems,
  canManageApiKey
} from '../../middleware/workspace.js';
import { getApiKeyByPublicId, deleteApiKey } from '../../models/apikeys.js';
import { FRIENDLY_CHARS } from '../../id.js';
import { formatRelativeTime } from './index.js';
import { recheckApiSessions } from '../api/sessions.js';

export const routes = new Hono();

// The public id's own shape, so these routes never catch /api-keys/generate.
const KEY_PATH = `/:apiKeyId{K[${FRIENDLY_CHARS}]{6}}`;

// A key the caller may not manage is not found, the same as one that does not
// exist, so its id reveals nothing.
const loadApiKey = async (c) => {
  const result = await getApiKeyByPublicId({ workspaceId: c.get('workspace').id, publicId: c.req.param('apiKeyId') });
  if (result.error) {
    consola.error('API could not read a key', { 'event.domain': 'api', 'error.type': String(result.error) });
    return null;
  }
  if (!result.data || !canManageApiKey(result.data, c.get('workspace'), c.get('user'))) {
    return null;
  }
  return result.data;
};

const renderPage = async (c, template, apiKey, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const now = Date.now();
  const { lastUsedTimestamp } = apiKey;
  return eta.render(template, {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildApiKeysBreadcrumbs(workspace, apiKey.name),
    apiKey: {
      publicId: apiKey.publicId,
      name: apiKey.name,
      keyPreview: apiKey.keyPreview,
      creatorEmail: apiKey.creatorEmail,
      expiresAt: new Date(apiKey.expiresTimestamp).toISOString(),
      expiresIn: formatRelativeTime(apiKey.expiresTimestamp - now),
      lastUsedAt: lastUsedTimestamp === null ? null : new Date(lastUsedTimestamp).toISOString(),
      lastUsedAgo: lastUsedTimestamp === null ? null : formatRelativeTime(lastUsedTimestamp - now)
    },
    ...data
  });
};

routes.get(KEY_PATH, requireUser, requireWorkspaceRole('User'), async (c) => {
  const apiKey = await loadApiKey(c);
  if (!apiKey) return c.text('Not found', 404);
  return c.html(await renderPage(c, 'apikeys/show', apiKey));
});

routes.get(`${KEY_PATH}/delete`, requireUser, requireWorkspaceRole('User'), async (c) => {
  const apiKey = await loadApiKey(c);
  if (!apiKey) return c.text('Not found', 404);
  return c.html(await renderPage(c, 'apikeys/delete', apiKey));
});

routes.post(`${KEY_PATH}/delete`, requireUser, requireWorkspaceRole('User'), requireSubmittedWorkspace, async (c) => {
  const body = await c.req.parseBody();
  const apiKey = await loadApiKey(c);
  if (!apiKey) return c.text('Not found', 404);
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(
      await renderPage(c, 'apikeys/delete', apiKey, { error: 'Your session expired. Please try again.' }),
      403
    );
  }
  const user = c.get('user');
  const workspace = c.get('workspace');
  const deleted = await deleteApiKey({ workspaceId: workspace.id, publicId: apiKey.publicId });
  if (deleted.error) {
    consola.error('API could not delete a key', { 'event.domain': 'api', 'error.type': String(deleted.error) });
    return c.html(
      await renderPage(c, 'apikeys/delete', apiKey, { error: 'Unable to delete the API key. Please try again.' }),
      500
    );
  }
  // End what the key opened now, not at the next periodic check.
  recheckApiSessions();
  consola.info('API key deleted', {
    'event.domain': 'api',
    'user.id': user.id,
    'workspace.id': workspace.id,
    'rb.api_key': apiKey.publicId,
    // Differs from user.id when an Admin revokes someone else's key.
    'rb.api_key_creator': apiKey.creatorUserId
  });
  return c.redirect('/api-keys', 303);
});
