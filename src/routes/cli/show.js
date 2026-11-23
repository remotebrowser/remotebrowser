import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSubmittedWorkspace,
  buildBreadcrumbs,
  loadWorkspaceSwitcherItems,
  canManageCliSession,
  hasAdminRole
} from '../../middleware/workspace.js';
import {
  getCliSessionByPublicId,
  deleteCliSession,
  listCliSessionsByUser,
  listCliSessionsByWorkspace
} from '../../models/cli.js';
import { FRIENDLY_CHARS } from '../../id.js';
import { formatRelativeTime } from '../apikeys/index.js';
import { recheckApiSessions } from '../api/sessions.js';

export const routes = new Hono();

const SESSION_PATH = `/:cliSessionId{C[${FRIENDLY_CHARS}]{10}}`;

const toIso = (timestamp) => (timestamp === null ? null : new Date(timestamp).toISOString());
const ago = (timestamp, now) => (timestamp === null ? null : formatRelativeTime(timestamp - now));

const summarizeCliSession = (session, now) => ({
  publicId: session.publicId,
  name: session.name,
  deviceName: session.deviceName,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  creatorEmail: session.creatorEmail,
  createdAt: toIso(session.createdTimestamp),
  createdAgo: ago(session.createdTimestamp, now),
  expiresAt: toIso(session.expiresTimestamp),
  expiresIn: ago(session.expiresTimestamp, now),
  // Null for a session that was never used; the page says "Never".
  lastUsedAt: toIso(session.lastUsedTimestamp),
  lastUsedAgo: ago(session.lastUsedTimestamp, now)
});

// As for API keys: Admins of a shared workspace see every member's sessions,
// so they can revoke the session of a lost laptop.
const seesAllCliSessions = (workspace) => hasAdminRole(workspace.role) && !workspace.isPersonal;

// For the workspace dashboard. A read error shows an empty list.
const loadCliSessions = async (c) => {
  const workspace = c.get('workspace');
  const listed = seesAllCliSessions(workspace)
    ? await listCliSessionsByWorkspace({ workspaceId: workspace.id })
    : await listCliSessionsByUser({ workspaceId: workspace.id, userId: c.get('user').id });
  if (listed.error) {
    consola.error('AUTH could not list the CLI sessions', {
      'event.domain': 'auth',
      'error.type': String(listed.error)
    });
    return [];
  }
  const now = Date.now();
  return listed.data.map((session) => summarizeCliSession(session, now));
};

// A session the caller may not manage gets the same 404 as one that does not
// exist, so its id reveals nothing.
const loadCliSession = async (c) => {
  const result = await getCliSessionByPublicId({
    workspaceId: c.get('workspace').id,
    publicId: c.req.param('cliSessionId')
  });
  if (result.error) {
    consola.error('AUTH could not read a CLI session', { 'event.domain': 'auth', 'error.type': String(result.error) });
    return null;
  }
  if (!result.data || !canManageCliSession(result.data, c.get('workspace'), c.get('user'))) {
    return null;
  }
  return result.data;
};

const renderShow = async (c, session, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render('cli/show', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBreadcrumbs(workspace, session.name),
    cliSession: summarizeCliSession(session, Date.now()),
    ...data
  });
};

routes.get(SESSION_PATH, requireUser, requireWorkspaceRole('User'), async (c) => {
  const session = await loadCliSession(c);
  if (!session) return c.text('Not found', 404);
  return c.html(await renderShow(c, session));
});

routes.post(
  `${SESSION_PATH}/revoke`,
  requireUser,
  requireWorkspaceRole('User'),
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    const session = await loadCliSession(c);
    if (!session) return c.text('Not found', 404);
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(await renderShow(c, session, { error: 'Your session expired. Please try again.' }), 403);
    }
    const user = c.get('user');
    const workspace = c.get('workspace');
    const deleted = await deleteCliSession({ workspaceId: workspace.id, publicId: session.publicId });
    if (deleted.error) {
      consola.error('AUTH could not revoke a CLI session', {
        'event.domain': 'auth',
        'error.type': String(deleted.error)
      });
      return c.html(
        await renderShow(c, session, { error: 'Unable to revoke the CLI session. Please try again.' }),
        500
      );
    }
    // End the CDP sessions it opened now, not at the next periodic check.
    recheckApiSessions();
    consola.info('CLI session revoked', {
      'event.domain': 'auth',
      'user.id': user.id,
      'workspace.id': workspace.id,
      'rb.cli_session': session.publicId,
      // Differs from user.id when an Admin revokes someone else's session.
      'rb.cli_session_creator': session.creatorUserId
    });
    return c.redirect('/', 303);
  }
);

export { loadCliSessions, seesAllCliSessions };
