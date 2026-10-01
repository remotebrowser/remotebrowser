import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./transfer.js');
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

test('POST /workspace/transfer requires Owner', async () => {
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

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/workspace/transfer', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      publicId: '999999',
      workspace: SHARED_WORKSPACE_ID,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 403);
});

test('POST /workspace/transfer commits the transfer for the Owner', async () => {
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
    role: 'Admin',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/workspace/transfer', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      publicId: other.data.publicId,
      workspace: SHARED_WORKSPACE_ID,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/workspace');
  const newOwner = await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId: otherUserId });
  assert.equal(newOwner.data.role, 'Owner');
  const oldOwner = await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId });
  assert.equal(oldOwner.data.role, 'Admin');
});

test('POST /workspace/transfer sends a personal workspace back to /', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie(created.data.publicId);
  const res = await app.request('/workspace/transfer', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      userId: '999999',
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('POST /workspace/transfer refuses a submission for a workspace the visitor is no longer active in', async () => {
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
    role: 'Admin',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/workspace/transfer', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      userId: String(otherUserId),
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 409);
  const owner2 = await getCollaborator({ workspaceId: SHARED_WORKSPACE_ID, userId });
  assert.equal(owner2.data.role, 'Owner', 'a rejected submission must write nothing');
});

test('POST /workspace/transfer answers a malformed target id with 400, not a 500', async () => {
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

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/workspace/transfer', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${ownerSession(owner.data.publicId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      publicId: 'not-a-public-id',
      workspace: SHARED_WORKSPACE_ID,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 400);
});
