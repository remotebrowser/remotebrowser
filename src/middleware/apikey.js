import { consola } from 'consola/basic';
import { isWellFormedApiKey } from '../apikey.js';
import { findActiveApiKey, recordApiKeyUse } from '../models/apikeys.js';
import { isCliToken, isWellFormedCliToken } from '../cli.js';
import { findCliSessionByToken, recordCliSessionUse } from '../models/cli.js';
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

// The credential behind a Bearer token: an API key or a CLI login. Both act
// for their creator in one workspace. An expired CLI token gets its own error,
// so the CLI can ask the user to log in again.
const findCredential = async (token, now) => {
  if (isCliToken(token)) {
    if (!isWellFormedCliToken(token)) return { data: null };
    const found = await findCliSessionByToken({ token });
    if (found.error || !found.data) return found;
    if (found.data.expiresTimestamp <= now) return { data: null, expired: true };
    return {
      data: {
        workspaceId: found.data.workspaceId,
        userId: found.data.creatorUserId,
        recordUse: () => recordCliSessionUse({ cliSessionId: found.data.cliSessionId, now }),
        log: { 'rb.cli_session': found.data.publicId }
      }
    };
  }
  // The MAC check refuses a wrong credential without a database read.
  if (!isWellFormedApiKey(token)) return { data: null };
  const found = await findActiveApiKey({ apiKey: token, now });
  if (found.error || !found.data) return found;
  return {
    data: {
      workspaceId: found.data.workspaceId,
      userId: found.data.creatorUserId,
      recordUse: () => recordApiKeyUse({ apiKeyId: found.data.apiKeyId, now }),
      log: { 'rb.api_key': found.data.publicId }
    }
  };
};

/**
 * Resolves an Authorization header to the user and workspace its API key or
 * CLI token acts for. Every wrong credential gets the same UNAUTHORIZED error,
 * so a caller cannot learn what was wrong. Only an expired CLI token adds
 * expired: true. Any other error means the lookup failed.
 * @param {string | undefined} authorization
 * @returns {Promise<{data?: {user: {id: number, email: string}, workspace: {id: number, role: string, isPersonal: boolean}, logAttributes: Record<string, string>}, error?: string, expired?: boolean}>}
 */
const authenticateApiKey = async (authorization, now = Date.now()) => {
  const match = BEARER_PATTERN.exec(typeof authorization === 'string' ? authorization : '');
  if (!match) return { error: 'UNAUTHORIZED' };
  const found = await findCredential(match[1], now);
  if (found.error) return { error: found.error };
  if (!found.data) return found.expired ? { error: 'UNAUTHORIZED', expired: true } : { error: 'UNAUTHORIZED' };
  const user = await getUser({ id: found.data.userId });
  if (user.error) return { error: user.error };
  if (!user.data) return { error: 'UNAUTHORIZED' };
  const workspace = await loadKeyWorkspace({ workspaceId: found.data.workspaceId, user: user.data });
  if (workspace.error) return { error: workspace.error };
  if (!workspace.data) return { error: 'UNAUTHORIZED' };
  // Only an accepted credential counts as used. Not awaited, so the request does not wait for this write.
  void found.data.recordUse().then((recorded) => {
    if (recorded.error) {
      consola.warn('API could not record a key use', { 'event.domain': 'api', 'error.type': String(recorded.error) });
    }
  });
  return {
    data: {
      user: { id: user.data.id, email: user.data.email },
      workspace: workspace.data,
      logAttributes: found.data.log
    }
  };
};

// Sets the same 'user' and 'workspace' as the session guards, so API handlers
// can share helpers with the pages.
const requireApiKey = async (c, next) => {
  const authenticated = await authenticateApiKey(c.req.header('Authorization'));
  if (authenticated.error === 'UNAUTHORIZED') {
    c.header('WWW-Authenticate', 'Bearer');
    // The CLI shows this text and adds how to log in again.
    if (authenticated.expired) return c.json({ error: 'Your login has expired.' }, 401);
    return c.json({ error: 'A valid API key is required.' }, 401);
  }
  if (authenticated.error) {
    consola.error('API could not check a key', { 'event.domain': 'api', 'error.type': String(authenticated.error) });
    return c.json({ error: 'Unable to check the API key. Please try again.' }, 503);
  }
  c.set('user', authenticated.data.user);
  c.set('workspace', authenticated.data.workspace);
  c.set('credentialLogAttributes', authenticated.data.logAttributes);
  await next();
};

export { authenticateApiKey, requireApiKey };
