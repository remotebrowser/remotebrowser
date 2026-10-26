import { consola } from 'consola/basic';
import { isWellFormedApiKey } from '../apikey.js';
import { findActiveApiKey, recordApiKeyUse } from '../models/apikeys.js';
import { getUser } from '../models/users.js';
import { getCollaborator } from '../models/workspaces.js';

const BEARER_PATTERN = /^Bearer +(\S+) *$/i;

// The workspace and role a key acts with are read again on every call, so
// removing its creator from the workspace stops the key at once.
const loadKeyWorkspace = async ({ workspaceId, user }) => {
  if (workspaceId === user.personalWorkspaceId) {
    return { data: { id: workspaceId, role: 'Owner', isPersonal: true } };
  }
  const collaborator = await getCollaborator({ workspaceId, userId: user.id });
  if (collaborator.error) return { error: collaborator.error };
  if (!collaborator.data) return { data: null };
  return { data: { id: workspaceId, role: collaborator.data.role, isPersonal: false } };
};

/**
 * Resolves an Authorization header to the user and workspace its API key acts
 * for. UNAUTHORIZED covers every way a key can be wrong, so a caller learns
 * nothing about which; any other error is a failed lookup.
 * @param {string | undefined} authorization
 * @returns {Promise<{data?: {user: {id: number, email: string}, workspace: {id: number, role: string, isPersonal: boolean}, apiKeyPublicId: string}, error?: string}>}
 */
const authenticateApiKey = async (authorization, now = Date.now()) => {
  const match = BEARER_PATTERN.exec(typeof authorization === 'string' ? authorization : '');
  // The MAC check refuses junk without a database read.
  if (!match || !isWellFormedApiKey(match[1])) return { error: 'UNAUTHORIZED' };
  const found = await findActiveApiKey({ apiKey: match[1], now });
  if (found.error) return { error: found.error };
  if (!found.data) return { error: 'UNAUTHORIZED' };
  const user = await getUser({ id: found.data.creatorUserId });
  if (user.error) return { error: user.error };
  if (!user.data) return { error: 'UNAUTHORIZED' };
  const workspace = await loadKeyWorkspace({ workspaceId: found.data.workspaceId, user: user.data });
  if (workspace.error) return { error: workspace.error };
  if (!workspace.data) return { error: 'UNAUTHORIZED' };
  // Only an accepted key counts as used. Not awaited: the call never waits on it.
  void recordApiKeyUse({ apiKeyId: found.data.apiKeyId, now }).then((recorded) => {
    if (recorded.error) {
      consola.warn('API could not record a key use', { 'event.domain': 'api', 'error.type': String(recorded.error) });
    }
  });
  return {
    data: {
      user: { id: user.data.id, email: user.data.email },
      workspace: workspace.data,
      apiKeyPublicId: found.data.publicId
    }
  };
};

// Sets the same 'user' and 'workspace' as the session guards, so API handlers
// can share helpers with the pages.
const requireApiKey = async (c, next) => {
  const authenticated = await authenticateApiKey(c.req.header('Authorization'));
  if (authenticated.error === 'UNAUTHORIZED') {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'A valid API key is required.' }, 401);
  }
  if (authenticated.error) {
    consola.error('API could not check a key', { 'event.domain': 'api', 'error.type': String(authenticated.error) });
    return c.json({ error: 'Unable to check the API key. Please try again.' }, 503);
  }
  c.set('user', authenticated.data.user);
  c.set('workspace', authenticated.data.workspace);
  c.set('apiKeyPublicId', authenticated.data.apiKeyPublicId);
  await next();
};

export { authenticateApiKey, requireApiKey };
