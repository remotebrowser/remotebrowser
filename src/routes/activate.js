import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../render.js';
import { absoluteOrigin } from '../origin.js';
import { createCsrfToken, verifyCsrfToken } from '../auth/csrf.js';
import { setReturnToCookie } from '../auth/session.js';
import { currentUser, requireUser } from '../middleware/auth.js';
import { listCollaboratorsByUser } from '../models/workspaces.js';
import { CLI_SESSION_DAYS, findPendingDeviceAuthorization, decideDeviceAuthorization } from '../models/cli.js';
import { normalizeUserCode, formatUserCode } from '../cli.js';
import { formString } from '../form.js';
import { formatRelativeTime } from './apikeys/index.js';

// The page where a signed-in user approves a CLI login (see src/routes/api/auth.js).
// The user must always confirm the code, even when it comes from a link with
// ?code=. Otherwise an attacker could start a login, send the link to a victim,
// and get a token for the victim's account.

export const routes = new Hono();

const PERSONAL_WORKSPACE_LABEL = 'Personal workspace';

// A signed-out visitor signs in first, then comes back here with the code kept.
const requireUserAndReturn = async (c, next) => {
  if (!(await currentUser(c))) {
    const code = normalizeUserCode(c.req.query('code') || '');
    setReturnToCookie(c, code ? `/activate?code=${formatUserCode(code)}` : '/activate');
    return c.redirect('/signin', 303);
  }
  return requireUser(c, next);
};

const render = (c, template, data = {}) =>
  eta.render(template, {
    error: null,
    csrfToken: createCsrfToken(c),
    serverOrigin: absoluteOrigin(c),
    days: CLI_SESSION_DAYS,
    ...data
  });

// Every workspace the user belongs to, their own first.
const loadWorkspaces = async (user) => {
  const listed = await listCollaboratorsByUser({ userId: user.id });
  if (listed.error) return { error: listed.error };
  const shared = listed.data
    .filter((collaborator) => collaborator.workspaceId !== user.personalWorkspaceId)
    .map((collaborator) => ({ id: collaborator.workspaceId, name: collaborator.workspaceName }));
  return { data: [{ id: user.personalWorkspaceId, name: PERSONAL_WORKSPACE_LABEL }, ...shared] };
};

const renderEntry = (c, data = {}) => c.html(render(c, 'activate/index', { code: '', ...data }), data.status ?? 200);

const renderConfirm = async (c, authorization, data = {}) => {
  const user = c.get('user');
  const workspaces = await loadWorkspaces(user);
  if (workspaces.error) {
    consola.error('AUTH could not list workspaces', { 'event.domain': 'auth', 'error.type': String(workspaces.error) });
    return renderEntry(c, { status: 503, error: 'Unable to load your workspaces. Please try again.' });
  }
  // The session's workspace is the likely choice.
  const activeId = user.activeWorkspaceId || user.personalWorkspaceId;
  const selectedId = workspaces.data.some((workspace) => workspace.id === activeId)
    ? activeId
    : user.personalWorkspaceId;
  return c.html(
    render(c, 'activate/confirm', {
      email: user.email,
      code: formatUserCode(authorization.userCode),
      deviceName: authorization.deviceName,
      ipAddress: authorization.ipAddress,
      requestedAt: new Date(authorization.createdTimestamp).toISOString(),
      requestedAgo: formatRelativeTime(authorization.createdTimestamp - Date.now()),
      workspaces: workspaces.data,
      selectedWorkspaceId: selectedId,
      ...data
    }),
    data.status ?? 200
  );
};

routes.get('/', requireUserAndReturn, (c) => {
  // Shown for the user to check, never approved from the link alone.
  const code = normalizeUserCode(c.req.query('code') || '');
  return renderEntry(c, { code: code ? formatUserCode(code) : '', fromLink: Boolean(code) });
});

routes.post('/', requireUser, async (c) => {
  const body = await c.req.parseBody();
  const typed = formString(body.code);
  if (!verifyCsrfToken(c, body.csrf)) {
    return renderEntry(c, { status: 403, code: typed, error: 'Your session expired. Please try again.' });
  }
  const code = normalizeUserCode(typed);
  const found = code ? await findPendingDeviceAuthorization({ userCode: code }) : { data: null };
  if (found.error) {
    consola.error('AUTH could not read a CLI login', { 'event.domain': 'auth', 'error.type': String(found.error) });
    return renderEntry(c, { status: 503, code: typed, error: 'Unable to check the code. Please try again.' });
  }
  if (!found.data) {
    return renderEntry(c, {
      status: 400,
      code: typed,
      error: 'This code is wrong or has expired. Check the code in your terminal.'
    });
  }
  return renderConfirm(c, found.data);
});

routes.post('/decide', requireUser, async (c) => {
  const body = await c.req.parseBody();
  const user = c.get('user');
  const code = normalizeUserCode(formString(body.code));
  if (!code) return renderEntry(c, { status: 400, error: 'This code is wrong or has expired.' });
  const found = await findPendingDeviceAuthorization({ userCode: code });
  if (found.error) {
    consola.error('AUTH could not read a CLI login', { 'event.domain': 'auth', 'error.type': String(found.error) });
    return renderEntry(c, { status: 503, error: 'Unable to check the code. Please try again.' });
  }
  if (!found.data) {
    return c.html(render(c, 'activate/done', { outcome: 'expired' }), 400);
  }
  if (!verifyCsrfToken(c, body.csrf)) {
    return renderConfirm(c, found.data, { status: 403, error: 'Your session expired. Please try again.' });
  }
  const approve = formString(body.decision) === 'approve';
  let workspaceId = null;
  if (approve) {
    const workspaces = await loadWorkspaces(user);
    if (workspaces.error) {
      consola.error('AUTH could not list workspaces', {
        'event.domain': 'auth',
        'error.type': String(workspaces.error)
      });
      return renderConfirm(c, found.data, { status: 503, error: 'Unable to load your workspaces. Please try again.' });
    }
    // Accept only a workspace the user belongs to, since form data cannot be trusted.
    const chosen = workspaces.data.find((workspace) => workspace.id === Number(formString(body.workspace)));
    if (!chosen) {
      return renderConfirm(c, found.data, { status: 400, error: 'Choose a workspace.' });
    }
    workspaceId = chosen.id;
  }
  const decided = await decideDeviceAuthorization({ userCode: code, approve, userId: user.id, workspaceId });
  if (decided.error) {
    consola.error('AUTH could not decide a CLI login', { 'event.domain': 'auth', 'error.type': String(decided.error) });
    return renderConfirm(c, found.data, { status: 503, error: 'Unable to save your choice. Please try again.' });
  }
  if (!decided.data) {
    return c.html(render(c, 'activate/done', { outcome: 'expired' }), 400);
  }
  consola.info(approve ? 'CLI login approved' : 'CLI login denied', {
    'event.domain': 'auth',
    'user.id': user.id,
    ...(approve ? { 'workspace.id': workspaceId } : {})
  });
  return c.html(render(c, 'activate/done', { outcome: approve ? 'approved' : 'denied' }));
});
