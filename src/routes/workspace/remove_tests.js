import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./remove.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, getCollaborator } = await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/workspace', routes);
  return app;
};

const makeSessionCookie = (publicId, over = {}) =>
  createSessionCookie({ publicId, email: 'user@example.com', issuedAt: Date.now(), ...over });
// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

const SHARED_WORKSPACE_ID = 2345;

// Seeds a real user + collaborator seat, one FK step at a time. Returns the
// generated user id and its public id (the one the URL carries).
const makeSeat = async ({ email, workspaceId = SHARED_WORKSPACE_ID, role, workspaceName = 'Acme Corp' }) => {
  const created = await findOrCreateUser({ email });
  const userId = created.data.id;
  await createCollaborator({ workspaceId, userId, email, role, workspaceName });
  return { id: userId, publicId: created.data.publicId };
};

const ownerSession = (publicId, activeWorkspaceId = SHARED_WORKSPACE_ID) =>
  makeSessionCookie(publicId, { activeWorkspaceId });

test('POST /workspace/:userId/remove lets a collaborator remove themselves from the active workspace', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${created.data.publicId}/remove`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(created.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/workspaces');
  assert.equal((await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId })).data, null);
});

test('POST /workspace/:userId/remove blocks removing the Owner', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'Owner',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${created.data.publicId}/remove`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(created.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /transfer ownership/i);
  assert.ok((await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId })).data, 'the Owner seat must survive');
});

test('POST /workspace/:userId/remove forbids a User removing someone else', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });
  const { id: otherUserId, publicId: otherPublicId } = await makeSeat({ email: 'other@example.com', role: 'User' });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${otherPublicId}/remove`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(created.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 403);
  assert.ok(
    (await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId: otherUserId })).data,
    'the target must survive a forbidden attempt'
  );
});

test('POST /workspace/:userId/remove answers a malformed id with 400, not a 500', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/workspace/not-a-number/remove', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(created.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 400);
});

test('POST /workspace/:userId/remove sends a personal workspace back to /', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie(created.data.publicId);
  const res = await app.request(`/workspace/${created.data.publicId}/remove`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: 9999, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('POST /workspace/:userId/remove refuses a submission for a workspace the visitor is no longer active in', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${created.data.publicId}/remove`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(created.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: 9999, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 409);
  assert.ok(
    (await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId })).data,
    'a rejected submission must write nothing'
  );
});
