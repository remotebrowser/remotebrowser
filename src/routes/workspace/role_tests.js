import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./role.js');
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

const ownerSession = (publicId, activeWorkspaceId = SHARED_WORKSPACE_ID) =>
  makeSessionCookie(publicId, { activeWorkspaceId });

test('POST /workspace/:userId/role updates the role for an Admin+ caller in the active workspace', async () => {
  const owner = await findOrCreateUser({ email: 'user@example.com' });
  const userId = owner.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'Owner',
    workspaceName: 'Acme Corp'
  });
  const other = await findOrCreateUser({ email: 'other@example.com' });
  const otherUserId = other.data.id;
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId: otherUserId,
    email: 'other@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${other.data.publicId}/role`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ role: 'Admin', workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/workspace');
  const target = await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId: otherUserId });
  assert.equal(target.data.role, 'Admin');
});

test('POST /workspace/:userId/role blocks an Admin from changing another Admin', async () => {
  const owner = await findOrCreateUser({ email: 'user@example.com' });
  const userId = owner.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'Admin',
    workspaceName: 'Acme Corp'
  });
  const other = await findOrCreateUser({ email: 'other@example.com' });
  const otherUserId = other.data.id;
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId: otherUserId,
    email: 'other@example.com',
    role: 'Admin',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${other.data.publicId}/role`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ role: 'User', workspace: SHARED_WORKSPACE_ID, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 403);
  const target = await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId: otherUserId });
  assert.equal(target.data.role, 'Admin', 'the target role must survive a forbidden attempt');
});

test('POST /workspace/:userId/role sends a personal workspace back to /', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie(created.data.publicId);
  const res = await app.request(`/workspace/${created.data.publicId}/role`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      role: 'Admin',
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('POST /workspace/:userId/role refuses a submission for a workspace the visitor is no longer active in', async () => {
  const owner = await findOrCreateUser({ email: 'user@example.com' });
  const userId = owner.data.id;
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: SHARED_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'Owner',
    workspaceName: 'Acme Corp'
  });
  const other = await findOrCreateUser({ email: 'other@example.com' });
  const otherUserId = other.data.id;
  await createCollaborator({
    workspaceId: SHARED_WORKSPACE_ID,
    userId: otherUserId,
    email: 'other@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request(`/workspace/${other.data.publicId}/role`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      role: 'Admin',
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 409);
  const target = await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId: otherUserId });
  assert.equal(target.data.role, 'User', 'a rejected submission must write nothing');
});
