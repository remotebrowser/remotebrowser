import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { authenticateApiKey, requireApiKey } = await import('./apikey.js');
const { createApiKey, getApiKeyByPublicId } = await import('../models/apikeys.js');
const { generateApiKey } = await import('../apikey.js');
const { findOrCreateUser } = await import('../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator, deleteCollaborator } =
  await import('../models/workspaces.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, personalWorkspaceId: workspace.data.workspaceId };
};

const makeKey = async ({ workspaceId, userId, expiration = '1d', now }) =>
  (await createApiKey({ workspaceId, userId, name: 'test', expiration, now })).data.apiKey;

test('authenticateApiKey resolves a key in a personal workspace to its creator as Owner', async () => {
  const { userId, personalWorkspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId: personalWorkspaceId, userId });
  const authenticated = await authenticateApiKey(`Bearer ${apiKey}`);
  assert.equal(authenticated.error, undefined);
  assert.equal(authenticated.data.user.id, userId);
  assert.deepEqual(authenticated.data.workspace, { id: personalWorkspaceId, role: 'Owner', isPersonal: true });
});

test('authenticateApiKey uses the creator’s current role in a shared workspace', async () => {
  const { userId } = await makeUser();
  await createWorkspace({ name: 'Acme', ownerId: userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme'
  });
  const apiKey = await makeKey({ workspaceId: 3333, userId });
  const authenticated = await authenticateApiKey(`Bearer ${apiKey}`);
  assert.deepEqual(authenticated.data.workspace, { id: 3333, role: 'User', isPersonal: false });
});

// The key belongs to the workspace, but acts for its creator: once they leave, it stops.
test('authenticateApiKey refuses a key whose creator left the workspace', async () => {
  const { userId } = await makeUser();
  await createWorkspace({ name: 'Acme', ownerId: userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme'
  });
  const apiKey = await makeKey({ workspaceId: 3333, userId });
  await deleteCollaborator({ workspaceId: 3333, userId });
  assert.deepEqual(await authenticateApiKey(`Bearer ${apiKey}`), { error: 'UNAUTHORIZED' });
});

test('authenticateApiKey refuses an expired key', async () => {
  const { userId, personalWorkspaceId } = await makeUser();
  const apiKey = await makeKey({
    workspaceId: personalWorkspaceId,
    userId,
    expiration: '1h',
    now: Date.now() - 2 * 60 * 60 * 1000
  });
  assert.deepEqual(await authenticateApiKey(`Bearer ${apiKey}`), { error: 'UNAUTHORIZED' });
});

test('authenticateApiKey refuses a missing, malformed, or unknown key', async () => {
  const { userId, personalWorkspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId: personalWorkspaceId, userId });
  for (const header of [
    undefined,
    '',
    apiKey,
    `Basic ${apiKey}`,
    `Bearer ${apiKey}x`,
    `Bearer ${apiKey} extra`,
    `Bearer ${generateApiKey()}`
  ]) {
    assert.deepEqual(await authenticateApiKey(header), { error: 'UNAUTHORIZED' }, `for ${header}`);
  }
});

test('requireApiKey answers 401 with a Bearer challenge, or lets the request through', async () => {
  const { userId, personalWorkspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId: personalWorkspaceId, userId });
  const app = new Hono();
  app.get('/', requireApiKey, (c) => c.json({ workspace: c.get('workspace').id, user: c.get('user').id }));

  const refused = await app.request('/');
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(await refused.json(), { error: 'A valid API key is required.' });

  const allowed = await app.request('/', { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { workspace: personalWorkspaceId, user: userId });
});

test('authenticateApiKey records when a key is used, and only when it is accepted', async () => {
  const { userId, personalWorkspaceId } = await makeUser();
  const created = await createApiKey({ workspaceId: personalWorkspaceId, userId, name: 'test', expiration: '1d' });
  const { apiKey, publicId } = created.data;
  const lastUsed = async () =>
    (await getApiKeyByPublicId({ workspaceId: personalWorkspaceId, userId, publicId })).data.lastUsedTimestamp;

  await authenticateApiKey(`Bearer ${apiKey}x`);
  assert.equal(await lastUsed(), null);

  const now = Date.now();
  await authenticateApiKey(`Bearer ${apiKey}`, now);
  // The write is not awaited by the caller, so wait for it here.
  for (let i = 0; i < 100 && (await lastUsed()) === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await lastUsed(), now);
});
