import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const {
  API_KEY_EXPIRATIONS,
  MAX_PERSONAL_API_KEYS,
  MAX_SHARED_API_KEYS_PER_MEMBER,
  createApiKey,
  listApiKeysByUser,
  countApiKeysByUser,
  listApiKeysByWorkspace,
  getApiKeyByPublicId,
  deleteApiKey,
  findActiveApiKey,
  recordApiKeyUse,
  cleanupApiKeys
} = await import('./apikeys.js');
const { isWellFormedApiKey, hashApiKey } = await import('../apikey.js');
const { findOrCreateUser } = await import('./users.js');
const { createWorkspace, deleteWorkspace } = await import('./workspaces.js');
const { generateShortId } = await import('../id.js');
const { getDatabase, closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const makeWorkspace = async (email = 'owner1@example.com') => {
  const owner = await findOrCreateUser({ email });
  const ownerId = owner.data.id;
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  return { workspaceId: workspace.data.workspaceId, ownerId };
};

const HOUR_MS = 60 * 60 * 1000;

test('API_KEY_EXPIRATIONS offers 1 hour, 1 day, 7, 30, and 90 days', () => {
  assert.deepEqual(
    API_KEY_EXPIRATIONS.map(({ value, label, ms }) => [value, label, ms / HOUR_MS]),
    [
      ['1h', '1 hour', 1],
      ['1d', '1 day', 24],
      ['7d', '7 days', 7 * 24],
      ['30d', '30 days', 30 * 24],
      ['90d', '90 days', 90 * 24]
    ]
  );
});

test('createApiKey returns the key once and stores only its digest', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  const created = await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration: '7d', now });
  assert.equal(created.error, undefined);
  const { apiKey } = created.data;
  assert.ok(isWellFormedApiKey(apiKey));
  assert.match(created.data.publicId, /^K[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  assert.equal(created.data.name, 'CI');
  assert.equal(created.data.creatorUserId, ownerId);
  assert.equal(created.data.createdTimestamp, now);
  assert.equal(created.data.expiresTimestamp, now + 7 * 24 * HOUR_MS);
  assert.equal(created.data.keyPreview, `${apiKey.slice(0, 13)}…`);

  const rows = (await (await getDatabase()).query('SELECT * FROM api_keys')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key_hash, hashApiKey(apiKey));
  assert.equal(Number(rows[0].workspace_id), workspaceId);
  assert.ok(!Object.values(rows[0]).includes(apiKey), 'the plain key must not be stored');
});

test('createApiKey refuses an expiration that is not offered', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  for (const expiration of ['', '2d', '365d', undefined]) {
    assert.deepEqual(await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration }), {
      error: 'INVALID_EXPIRATION'
    });
  }
  assert.deepEqual(await listApiKeysByUser({ workspaceId, userId: ownerId }), { data: [] });
});

test('createApiKey redraws the public id when the drawn one is taken', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const first = await createApiKey({ workspaceId, userId: ownerId, name: 'first', expiration: '1h' });
  let calls = 0;
  const generateId = () => (calls++ === 0 ? first.data.publicId : generateShortId('K', 6));
  const second = await createApiKey({ workspaceId, userId: ownerId, name: 'second', expiration: '1h', generateId });
  assert.equal(second.error, undefined);
  assert.equal(calls, 2);
  assert.notEqual(second.data.publicId, first.data.publicId);
});

test('listApiKeysByUser lists only the caller’s keys in that workspace, newest first', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const other = await makeWorkspace('owner2@example.com');
  await createApiKey({ workspaceId, userId: ownerId, name: 'older', expiration: '1d' });
  await createApiKey({ workspaceId, userId: ownerId, name: 'newer', expiration: '1d' });
  await createApiKey({ workspaceId, userId: other.ownerId, name: 'someone else', expiration: '1d' });
  await createApiKey({ workspaceId: other.workspaceId, userId: ownerId, name: 'other workspace', expiration: '1d' });

  const listed = await listApiKeysByUser({ workspaceId, userId: ownerId });
  assert.deepEqual(
    listed.data.map((key) => key.name),
    ['newer', 'older']
  );
  assert.ok(
    listed.data.every((key) => !('apiKey' in key)),
    'a listed key never carries the plain key'
  );
});

test('deleting a workspace deletes its API keys', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration: '1d' });
  await deleteWorkspace({ workspaceId });
  const rows = (await (await getDatabase()).query('SELECT * FROM api_keys')).rows;
  assert.equal(rows.length, 0);
});

test('findActiveApiKey finds a key by its value until it expires', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  const created = await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration: '1h', now });

  const found = await findActiveApiKey({ apiKey: created.data.apiKey, now: now + HOUR_MS - 1 });
  assert.equal(found.data.publicId, created.data.publicId);
  assert.equal(found.data.workspaceId, workspaceId);
  assert.equal(found.data.creatorUserId, ownerId);

  assert.deepEqual(await findActiveApiKey({ apiKey: created.data.apiKey, now: now + HOUR_MS }), { data: null });
  assert.deepEqual(await findActiveApiKey({ apiKey: `${created.data.apiKey}x`, now }), { data: null });
});

test('listApiKeysByUser leaves out expired keys, and stops at the limit', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  await createApiKey({ workspaceId, userId: ownerId, name: 'expired', expiration: '1h', now: now - 2 * HOUR_MS });
  for (const name of ['a', 'b', 'c']) {
    await createApiKey({ workspaceId, userId: ownerId, name, expiration: '1d', now });
  }
  const names = async (options) =>
    (await listApiKeysByUser({ workspaceId, userId: ownerId, now, ...options })).data.map((key) => key.name);
  assert.deepEqual(await names({}), ['c', 'b', 'a']);
  assert.deepEqual(await names({ limit: 2 }), ['c', 'b']);
});

test('getApiKeyByPublicId finds a valid key of the workspace, whoever made it, with its creator’s email', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const other = await makeWorkspace('owner2@example.com');
  const now = 1_700_000_000_000;
  const created = await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration: '1h', now });
  const { publicId } = created.data;

  const found = await getApiKeyByPublicId({ workspaceId, publicId, now });
  assert.equal(found.data.name, 'CI');
  assert.equal(found.data.creatorUserId, ownerId);
  assert.equal(found.data.creatorEmail, 'owner1@example.com');
  for (const params of [
    { workspaceId: other.workspaceId, publicId, now },
    { workspaceId, publicId, now: now + HOUR_MS }
  ]) {
    assert.deepEqual(await getApiKeyByPublicId(params), { data: null });
  }
});

test('deleteApiKey deletes a key only within its own workspace', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const other = await makeWorkspace('owner2@example.com');
  const created = await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration: '1d' });
  const { publicId } = created.data;
  assert.deepEqual(await deleteApiKey({ workspaceId: other.workspaceId, publicId }), { data: false });
  assert.deepEqual(await deleteApiKey({ workspaceId, publicId }), { data: true });
  assert.deepEqual(await listApiKeysByUser({ workspaceId, userId: ownerId }), { data: [] });
});

test('listApiKeysByWorkspace lists every member’s valid keys, newest first, with their creators', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const other = await makeWorkspace('owner2@example.com');
  const now = 1_700_000_000_000;
  await createApiKey({ workspaceId, userId: ownerId, name: 'mine', expiration: '1d', now });
  await createApiKey({ workspaceId, userId: other.ownerId, name: 'theirs', expiration: '1d', now });
  await createApiKey({ workspaceId, userId: other.ownerId, name: 'expired', expiration: '1h', now: now - 2 * HOUR_MS });
  await createApiKey({
    workspaceId: other.workspaceId,
    userId: other.ownerId,
    name: 'elsewhere',
    expiration: '1d',
    now
  });

  const listed = (await listApiKeysByWorkspace({ workspaceId, now })).data;
  assert.deepEqual(
    listed.map((key) => [key.name, key.creatorEmail]),
    [
      ['theirs', 'owner2@example.com'],
      ['mine', 'owner1@example.com']
    ]
  );
  assert.deepEqual(
    (await listApiKeysByWorkspace({ workspaceId, now, limit: 1 })).data.map((key) => key.name),
    ['theirs']
  );
});

test('recordApiKeyUse writes the time at most once a minute per key', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  const created = await createApiKey({ workspaceId, userId: ownerId, name: 'CI', expiration: '1d', now });
  const { apiKeyId, publicId } = created.data;
  const lastUsed = async () =>
    (await getApiKeyByPublicId({ workspaceId, userId: ownerId, publicId, now })).data.lastUsedTimestamp;

  assert.equal(created.data.lastUsedTimestamp, null, 'a new key has never been used');
  assert.deepEqual(await recordApiKeyUse({ apiKeyId, now }), { data: true });
  assert.deepEqual(await recordApiKeyUse({ apiKeyId, now: now + 59_999 }), { data: false });
  assert.equal(await lastUsed(), now);
  assert.deepEqual(await recordApiKeyUse({ apiKeyId, now: now + 60_000 }), { data: true });
  assert.equal(await lastUsed(), now + 60_000);
});

test('cleanupApiKeys removes only expired keys', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  await createApiKey({ workspaceId, userId: ownerId, name: 'expired', expiration: '1h', now: now - 2 * HOUR_MS });
  // Expired at this very moment: findActiveApiKey already refuses it.
  await createApiKey({ workspaceId, userId: ownerId, name: 'just expired', expiration: '1h', now: now - HOUR_MS });
  await createApiKey({ workspaceId, userId: ownerId, name: 'live', expiration: '1d', now });

  assert.deepEqual(await cleanupApiKeys({ now }), { data: 2 });
  const rows = (await (await getDatabase()).query('SELECT name FROM api_keys')).rows;
  assert.deepEqual(
    rows.map((row) => row.name),
    ['live']
  );
  assert.deepEqual(await cleanupApiKeys({ now }), { data: 0 });
});

test('cleanupApiKeys removes at most the limit per call, oldest first', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  for (const hoursAgo of [3, 5, 4]) {
    await createApiKey({
      workspaceId,
      userId: ownerId,
      name: `${hoursAgo}h`,
      expiration: '1h',
      now: now - hoursAgo * HOUR_MS
    });
  }
  assert.deepEqual(await cleanupApiKeys({ now, limit: 2 }), { data: 2 });
  const rows = (await (await getDatabase()).query('SELECT name FROM api_keys')).rows;
  assert.deepEqual(
    rows.map((row) => row.name),
    ['3h']
  );
});

test('countApiKeysByUser counts only the caller’s valid keys in that workspace', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const other = await makeWorkspace('owner2@example.com');
  const now = 1_700_000_000_000;
  assert.deepEqual(await countApiKeysByUser({ workspaceId, userId: ownerId, now }), { data: 0 });
  await createApiKey({ workspaceId, userId: ownerId, name: 'a', expiration: '1d', now });
  await createApiKey({ workspaceId, userId: ownerId, name: 'b', expiration: '1d', now });
  await createApiKey({ workspaceId, userId: ownerId, name: 'expired', expiration: '1h', now: now - 2 * HOUR_MS });
  await createApiKey({ workspaceId, userId: other.ownerId, name: 'theirs', expiration: '1d', now });
  await createApiKey({ workspaceId: other.workspaceId, userId: ownerId, name: 'elsewhere', expiration: '1d', now });
  assert.deepEqual(await countApiKeysByUser({ workspaceId, userId: ownerId, now }), { data: 2 });
});

test('createApiKey with maxKeys refuses one more than that many valid keys', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const now = 1_700_000_000_000;
  const create = (over = {}) =>
    createApiKey({ workspaceId, userId: ownerId, name: 'k', expiration: '1d', maxKeys: 2, now, ...over });
  // An expired key does not count against the limit.
  await create({ expiration: '1h', now: now - 2 * HOUR_MS });
  assert.equal((await create()).error, undefined);
  assert.equal((await create()).error, undefined);
  assert.deepEqual(await create(), { error: 'TOO_MANY_API_KEYS' });
  // Without maxKeys, as in a shared workspace, there is no limit.
  assert.equal((await create({ maxKeys: null })).error, undefined);
});

test('a person may hold 10 API keys in a personal workspace, and 5 in each shared one', () => {
  assert.equal(MAX_PERSONAL_API_KEYS, 10);
  assert.equal(MAX_SHARED_API_KEYS_PER_MEMBER, 5);
});
