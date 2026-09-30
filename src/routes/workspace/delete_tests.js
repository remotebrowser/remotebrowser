import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./delete.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace, getCollaborator, workspaceExists } =
  await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/workspace', routes);
  return app;
};

let userId;
let userPublicId;
const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });
// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

const SHARED_WORKSPACE_ID = 2345;

// Seeds the signed-in user and a shared workspace they belong to at the given role.
const makeCollaborator = async ({ workspaceId = SHARED_WORKSPACE_ID, role, workspaceName = 'Acme Corp' } = {}) => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  await createWorkspace({ name: workspaceName, ownerId: userId, workspaceId });
  await createCollaborator({ workspaceId, userId, email: 'user@example.com', role, workspaceName });
};

const ownerSession = (activeWorkspaceId = SHARED_WORKSPACE_ID) =>
  makeSessionCookie({ activeWorkspaceId: activeWorkspaceId });

const postDelete = (app, { name, workspace = SHARED_WORKSPACE_ID, csrfId = 'a'.repeat(32) }) =>
  app.request('/workspace/delete', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name, workspace, csrf: makeCsrfToken(csrfId) }).toString()
  });

test('GET /workspace/delete redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/workspace/delete');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /workspace/delete requires Owner', async () => {
  await makeCollaborator({ role: 'Admin' });
  const app = setupApp();
  const res = await app.request('/workspace/delete', { headers: { cookie: `session=${ownerSession()}` } });
  assert.equal(res.status, 403);
});

test('GET /workspace/delete warns that deletion is permanent and asks for the workspace name', async () => {
  await makeCollaborator({ role: 'Owner' });
  const app = setupApp();
  const res = await app.request('/workspace/delete', { headers: { cookie: `session=${ownerSession()}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /permanent and cannot be undone/i);
  assert.match(body, /action="\/workspace\/delete"/);
  assert.match(body, /name="name"/);
  assert.match(body, new RegExp(`name="workspace" value="${SHARED_WORKSPACE_ID}"`));
  assert.match(body, /Confirm workspace name/);
  assert.match(body, /class="btn-danger">Delete</);
  assert.match(body, /href="\/workspace" class="btn-secondary">Cancel/);
  assert.doesNotMatch(body, /<h1/);
  assert.doesNotMatch(body, /browsers/i);
  // Acme Corp > Collaborators > Delete.
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /href="\/workspace">\s*Collaborators/);
  assert.match(body, /aria-current="page">\s*Delete/);
});

test('POST /workspace/delete rejects a missing or invalid CSRF token', async () => {
  await makeCollaborator({ role: 'Owner' });
  const app = setupApp();
  const res = await app.request('/workspace/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `session=${ownerSession()}` },
    body: new URLSearchParams({ name: 'Acme Corp', workspace: SHARED_WORKSPACE_ID, csrf: 'bogus' }).toString()
  });
  assert.equal(res.status, 403);
  assert.ok(
    (await workspaceExists({ workspaceId: SHARED_WORKSPACE_ID })).data,
    'the workspace must survive a rejected CSRF token'
  );
});

test('POST /workspace/delete keeps the workspace when the typed name does not match', async () => {
  await makeCollaborator({ role: 'Owner' });
  const res = await postDelete(setupApp(), { name: 'acme corp' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /does not match/i);
  assert.ok(
    (await workspaceExists({ workspaceId: SHARED_WORKSPACE_ID })).data,
    'a name mismatch must not delete the workspace'
  );
});

test('POST /workspace/delete deletes the workspace and redirects to /workspaces when the name matches', async () => {
  await makeCollaborator({ role: 'Owner' });
  const res = await postDelete(setupApp(), { name: '  Acme Corp  ' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/workspaces');
  assert.equal((await workspaceExists({ workspaceId: SHARED_WORKSPACE_ID })).data, false);
});

test('POST /workspace/delete refuses a submission for a workspace the visitor is no longer active in', async () => {
  await makeCollaborator({ role: 'Owner' });
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/workspace/delete', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'Acme Corp',
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 409);
  assert.ok(
    (await workspaceExists({ workspaceId: SHARED_WORKSPACE_ID })).data,
    'a rejected submission must not delete anything'
  );
});

test('a personal workspace can be neither reached nor deleted through the delete page', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const personal = await ensurePersonalWorkspace({
    userId,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const shown = await app.request('/workspace/delete', { headers: { cookie: `session=${cookie}` } });
  assert.equal(shown.status, 303);
  assert.equal(shown.headers.get('location'), '/');
  const submitted = await app.request('/workspace/delete', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name: 'Personal', csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(submitted.status, 303);
  assert.equal(submitted.headers.get('location'), '/');
  // requireSharedWorkspace redirects before the cascade delete is ever reached.
  assert.ok((await workspaceExists({ workspaceId: personal.data.workspaceId })).data);
  assert.ok((await getCollaborator({ workspaceId: personal.data.workspaceId, userId })).data);
});
