import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../../auth/signing.js');
const { createSessionCookie } = await import('../../../auth/session.js');
const { latestSignInCode } = await import('../../../auth/magic.js');
const { routes } = await import('./index.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { createWorkspace, createCollaborator, listInvitationsByWorkspace } =
  await import('../../../models/workspaces.js');
const { closeDatabase } = await import('../../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/workspace/invite', routes);
  return app;
};

let userId;
let userPublicId;
const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

const SHARED_WORKSPACE_ID = 2345;

const makeCollaborator = async ({ workspaceId = SHARED_WORKSPACE_ID, role, workspaceName = 'Acme Corp' } = {}) => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  await createWorkspace({ name: workspaceName, ownerId: userId, workspaceId });
  await createCollaborator({ workspaceId, userId, email: 'user@example.com', role, workspaceName });
};

const ownerSession = (activeWorkspaceId = SHARED_WORKSPACE_ID) =>
  makeSessionCookie({ activeWorkspaceId: activeWorkspaceId });

// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

test('GET /workspace/invite renders the email form for an Admin+ caller in the active workspace', async () => {
  await makeCollaborator({ role: 'Owner' });
  const res = await setupApp().request('/workspace/invite', { headers: { cookie: `session=${ownerSession()}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /action="\/workspace\/invite"/);
  assert.match(body, new RegExp(`name="workspace" value="${SHARED_WORKSPACE_ID}"`));
  assert.match(body, /Send invite/);
  assert.match(body, /href="\/workspace" class="btn-secondary">Cancel/);
  assert.doesNotMatch(body, /name="role"/);
  // The breadcrumb already names the workspace, so the page itself does not.
  assert.doesNotMatch(body, /<h1/);
  assert.match(body, /They join the workspace as soon as/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /href="\/workspace">\s*Collaborators/);
  assert.match(body, /aria-current="page">\s*Invite/);
});

test('GET /workspace/invite requires Admin or Owner', async () => {
  await makeCollaborator({ role: 'User' });
  const res = await setupApp().request('/workspace/invite', { headers: { cookie: `session=${ownerSession()}` } });
  assert.equal(res.status, 403);
});

test('POST /workspace/invite requires Admin or Owner', async () => {
  await makeCollaborator({ role: 'User' });
  const csrfId = 'a'.repeat(32);
  const res = await setupApp().request('/workspace/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      email: 'new@example.com',
      workspace: SHARED_WORKSPACE_ID,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 403);
});

test('POST /workspace/invite creates a User invitation, issues a sign-in link, and redirects to the sent page', async () => {
  await makeCollaborator({ role: 'Owner' });
  const csrfId = 'a'.repeat(32);
  const res = await setupApp().request('/workspace/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      email: 'New@Example.com',
      workspace: SHARED_WORKSPACE_ID,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/workspace/invite/sent?email=new%40example.com');

  const invitations = await listInvitationsByWorkspace({ workspaceId: SHARED_WORKSPACE_ID });
  const created = invitations.data.find((i) => i.email === 'new@example.com');
  assert.ok(created, 'the invitation must be persisted, lowercased');
  assert.equal(created.role, 'User');
  assert.equal(created.workspaceName, 'Acme Corp');
  assert.ok(latestSignInCode('new@example.com'), 'a sign-in link must be issued for the invited email');
});

test('POST /workspace/invite rejects a missing email', async () => {
  await makeCollaborator({ role: 'Owner' });
  const csrfId = 'a'.repeat(32);
  const res = await setupApp().request('/workspace/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ email: '  ', workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /valid email address is required/);
  assert.equal((await listInvitationsByWorkspace({ workspaceId: SHARED_WORKSPACE_ID })).data.length, 0);
});

test('POST /workspace/invite rejects a stale CSRF token', async () => {
  await makeCollaborator({ role: 'Owner' });
  const res = await setupApp().request('/workspace/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${'a'.repeat(32)}`
    },
    body: new URLSearchParams({
      email: 'new@example.com',
      workspace: SHARED_WORKSPACE_ID,
      csrf: 'bogus'
    }).toString()
  });
  assert.equal(res.status, 403);
  assert.equal((await listInvitationsByWorkspace({ workspaceId: SHARED_WORKSPACE_ID })).data.length, 0);
});

test('POST /workspace/invite refuses a submission for a workspace the visitor is no longer active in', async () => {
  await makeCollaborator({ role: 'Owner' });
  const csrfId = 'a'.repeat(32);
  const res = await setupApp().request('/workspace/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      email: 'new@example.com',
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 409);
  assert.equal((await listInvitationsByWorkspace({ workspaceId: SHARED_WORKSPACE_ID })).data.length, 0);
});

test('a personal workspace has no invite page, and no invite may be sent from it', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const shown = await app.request('/workspace/invite', { headers: { cookie: `session=${cookie}` } });
  assert.equal(shown.status, 303);
  assert.equal(shown.headers.get('location'), '/');
  const submitted = await app.request('/workspace/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ email: 'someone@example.com', csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(submitted.status, 303);
  assert.equal(submitted.headers.get('location'), '/');
  assert.equal(latestSignInCode('someone@example.com'), null, 'no sign-in link is sent from a personal workspace');
});
