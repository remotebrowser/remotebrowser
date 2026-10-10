import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const { getUser, findOrCreateUser, revokeSessions, setPersonalWorkspaceId, recordSigninCode, consumeSigninCode } =
  await import('./users.js');
const { deleteExpiredSigninCodes } = await import('./users.js');
const { generateShortId } = await import('../id.js');
const { createNonce } = await import('../auth/nonce.js');
const { createWorkspace } = await import('./workspaces.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

test('getUser returns null for an unknown id', async () => {
  const result = await getUser({ id: 404 });
  assert.deepEqual(result, { data: null });
});

test('findOrCreateUser creates a user on first sign-in and updates it on the next', async () => {
  const created = await findOrCreateUser({ email: 'first@example.com' });
  assert.equal(created.error, undefined);
  assert.equal(created.data.isNewUser, true);
  assert.equal(typeof created.data.id, 'number');

  const afterCreate = await getUser({ id: created.data.id });
  assert.equal(afterCreate.data.email, 'first@example.com');
  assert.equal(afterCreate.data.sessionExpirationTimestamp, 0);
  assert.equal(afterCreate.data.personalWorkspaceId, null);

  const updated = await findOrCreateUser({ email: 'first@example.com' });
  assert.deepEqual(updated, { data: { id: created.data.id, publicId: created.data.publicId, isNewUser: false } });

  const afterUpdate = await getUser({ id: created.data.id });
  // A returning sign-in resolves to the same row, so the id is untouched.
  assert.equal(afterUpdate.data.email, 'first@example.com');
});

test('findOrCreateUser mints an id on first sign-in and reuses it on the next', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  assert.equal(created.data.isNewUser, true);

  const returning = await findOrCreateUser({ email: 'user@example.com' });
  assert.equal(returning.data.isNewUser, false);
  assert.equal(returning.data.id, created.data.id, 'a returning email must resolve to its existing id');
});

test('findOrCreateUser assigns a friendly 6-character public id prefixed with U', async () => {
  const created = await findOrCreateUser({ email: 'public@example.com' });
  const user = await getUser({ id: created.data.id });
  assert.match(user.data.publicId, /^U[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
});

test('findOrCreateUser regenerates the public id when the drawn one is taken', async () => {
  const first = await findOrCreateUser({ email: 'first@example.com' });
  const taken = (await getUser({ id: first.data.id })).data.publicId;

  let calls = 0;
  const generateId = () => (calls++ === 0 ? taken : generateShortId('U', 6));
  const second = await findOrCreateUser({ email: 'second@example.com', generateId });

  assert.equal(second.error, undefined);
  assert.equal(second.data.isNewUser, true);
  assert.equal(calls, 2, 'the collision must trigger exactly one redraw');
  assert.notEqual((await getUser({ id: second.data.id })).data.publicId, taken);
});

test('revokeSessions sets session_expiration_timestamp and reports whether a row existed', async () => {
  const { data: user } = await findOrCreateUser({ email: 'user@example.com' });

  const missing = await revokeSessions({ id: 404, expirationTimestamp: 123 });
  assert.deepEqual(missing, { data: false });

  const revoked = await revokeSessions({ id: user.id, expirationTimestamp: 123 });
  assert.deepEqual(revoked, { data: true });

  const afterRevoke = await getUser({ id: user.id });
  assert.equal(afterRevoke.data.sessionExpirationTimestamp, 123);
});

test('setPersonalWorkspaceId is write-once: it sets an empty pointer and refuses to replace one', async () => {
  const { data: user } = await findOrCreateUser({ email: 'user@example.com' });
  // personal_workspace_id is FK'd to workspaces, so the pointer must name a real row.
  await createWorkspace({ name: 'Personal', ownerId: user.id, personal: true, workspaceId: 2345 });
  // A second, unrelated workspace to try (and fail) to re-point the pointer at.
  await createWorkspace({ name: 'Team', ownerId: user.id, workspaceId: 6789 });

  const missing = await setPersonalWorkspaceId({ id: 404, workspaceId: 2345 });
  assert.deepEqual(missing, { error: 'ALREADY_SET' });

  const set = await setPersonalWorkspaceId({ id: user.id, workspaceId: 2345 });
  assert.deepEqual(set, { data: true });

  const afterSet = await getUser({ id: user.id });
  assert.equal(afterSet.data.personalWorkspaceId, 2345);

  // A second call must not re-point an already-claimed pointer.
  const replaced = await setPersonalWorkspaceId({ id: user.id, workspaceId: 6789 });
  assert.deepEqual(replaced, { error: 'ALREADY_SET' });
  assert.equal((await getUser({ id: user.id })).data.personalWorkspaceId, 2345);
});

const seedCode = async (email) => {
  const { token, expires } = createNonce(email);
  const recorded = await recordSigninCode({ token, email, expires });
  assert.equal(recorded.error, undefined);
  return token;
};

test('consumeSigninCode returns the email for a recorded, matching code', async () => {
  const token = await seedCode('user@example.com');
  const result = await consumeSigninCode({ token, email: 'user@example.com' });
  assert.deepEqual(result, { data: { email: 'user@example.com' } });
});

test('consumeSigninCode rejects an unknown code', async () => {
  const { token } = createNonce('user@example.com');
  const result = await consumeSigninCode({ token, email: 'user@example.com' });
  assert.equal(result.error, 'INVALID_CODE');
});

test('consumeSigninCode rejects a code bound to a different email', async () => {
  const token = await seedCode('a@example.com');
  const result = await consumeSigninCode({ token, email: 'b@example.com' });
  assert.equal(result.error, 'INVALID_CODE');
});

test('a code is single-use: the second consume fails', async () => {
  const token = await seedCode('user@example.com');
  assert.deepEqual(await consumeSigninCode({ token, email: 'user@example.com' }), {
    data: { email: 'user@example.com' }
  });
  assert.equal((await consumeSigninCode({ token, email: 'user@example.com' })).error, 'INVALID_CODE');
});

test('deleteExpiredSigninCodes removes only expired codes', async () => {
  const live = await seedCode('live@example.com');
  const stale = createNonce('stale@example.com');
  await recordSigninCode({ token: stale.token, email: 'stale@example.com', expires: Date.now() - 1000 });

  assert.deepEqual(await deleteExpiredSigninCodes(), { data: 1 });
  assert.deepEqual(await consumeSigninCode({ token: live, email: 'live@example.com' }), {
    data: { email: 'live@example.com' }
  });
  assert.equal((await consumeSigninCode({ token: stale.token, email: 'stale@example.com' })).error, 'INVALID_CODE');
});

test('deleteExpiredSigninCodes deletes at most the limit per call, oldest first', async () => {
  const now = Date.now();
  const tokens = [];
  for (const [index, age] of [3000, 2000, 1000].entries()) {
    const { token } = createNonce(`u${index}@example.com`);
    tokens.push(token);
    await recordSigninCode({ token, email: `u${index}@example.com`, expires: now - age });
  }

  assert.deepEqual(await deleteExpiredSigninCodes({ now, limit: 2 }), { data: 2 });
  assert.deepEqual(await deleteExpiredSigninCodes({ now, limit: 2 }), { data: 1 });
  assert.deepEqual(await deleteExpiredSigninCodes({ now, limit: 2 }), { data: 0 });
});
