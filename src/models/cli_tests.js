import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const {
  CLI_SESSION_DAYS,
  createDeviceAuthorization,
  findPendingDeviceAuthorization,
  decideDeviceAuthorization,
  pollDeviceAuthorization,
  listCliSessionsByUser,
  listCliSessionsByWorkspace,
  getCliSessionByPublicId,
  deleteCliSession,
  deleteCliSessionByToken,
  findCliSessionByToken,
  recordCliSessionUse,
  cleanupCliSessions
} = await import('./cli.js');
const { isWellFormedCliToken, hashSecret } = await import('../cli.js');
const { findOrCreateUser } = await import('./users.js');
const { ensurePersonalWorkspace } = await import('./workspaces.js');
const { getDatabase, closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, workspaceId: workspace.data.workspaceId };
};

// Runs the whole flow and returns the issued token.
const login = async (user, { now = T0, deviceName = 'my-laptop' } = {}) => {
  const started = await createDeviceAuthorization({ deviceName, ipAddress: '10.0.0.1', userAgent: 'rb/1', now });
  await decideDeviceAuthorization({ userCode: started.data.userCode, approve: true, ...user, now: now + 1000 });
  const polled = await pollDeviceAuthorization({ deviceCode: started.data.deviceCode, now: now + 2000 });
  return polled.data;
};

test('createDeviceAuthorization stores only a digest of the device code', async () => {
  const started = await createDeviceAuthorization({ deviceName: 'laptop', ipAddress: null, userAgent: null, now: T0 });
  assert.equal(started.error, undefined);
  assert.equal(started.data.status, 'pending');
  assert.equal(started.data.expiresTimestamp, T0 + 15 * 60 * 1000);
  const rows = (await (await getDatabase()).query('SELECT * FROM device_authorizations')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_code_hash, hashSecret(started.data.deviceCode));
  assert.ok(!JSON.stringify(rows[0]).includes(started.data.deviceCode));
});

test('createDeviceAuthorization clips a long device name', async () => {
  const started = await createDeviceAuthorization({ deviceName: 'x'.repeat(500), now: T0 });
  assert.equal(started.data.deviceName.length, 64);
});

test('findPendingDeviceAuthorization finds only a live pending login', async () => {
  const started = await createDeviceAuthorization({ deviceName: 'laptop', now: T0 });
  const { userCode } = started.data;
  assert.equal((await findPendingDeviceAuthorization({ userCode, now: T0 + 1 })).data.deviceName, 'laptop');
  assert.equal((await findPendingDeviceAuthorization({ userCode, now: T0 + 16 * 60 * 1000 })).data, null);
  await decideDeviceAuthorization({ userCode, approve: false, now: T0 + 1 });
  assert.equal((await findPendingDeviceAuthorization({ userCode, now: T0 + 1 })).data, null);
});

test('pollDeviceAuthorization says pending, then slow_down when polled too soon', async () => {
  const started = await createDeviceAuthorization({ now: T0 });
  const { deviceCode } = started.data;
  assert.equal((await pollDeviceAuthorization({ deviceCode, now: T0 + 5000 })).data.status, 'pending');
  assert.equal((await pollDeviceAuthorization({ deviceCode, now: T0 + 6000 })).data.status, 'slow_down');
  assert.equal((await pollDeviceAuthorization({ deviceCode, now: T0 + 11_000 })).data.status, 'pending');
});

test('pollDeviceAuthorization says denied after a denial', async () => {
  const started = await createDeviceAuthorization({ now: T0 });
  await decideDeviceAuthorization({ userCode: started.data.userCode, approve: false, now: T0 + 1 });
  assert.equal(
    (await pollDeviceAuthorization({ deviceCode: started.data.deviceCode, now: T0 + 5000 })).data.status,
    'denied'
  );
});

test('pollDeviceAuthorization says expired for an unknown or expired code', async () => {
  assert.equal((await pollDeviceAuthorization({ deviceCode: 'nope', now: T0 })).data.status, 'expired');
  assert.equal((await pollDeviceAuthorization({ deviceCode: undefined, now: T0 })).data.status, 'expired');
  const started = await createDeviceAuthorization({ now: T0 });
  const late = T0 + 15 * 60 * 1000;
  assert.equal(
    (await pollDeviceAuthorization({ deviceCode: started.data.deviceCode, now: late })).data.status,
    'expired'
  );
});

test('pollDeviceAuthorization issues a token once, valid for 30 days, to the approved workspace', async () => {
  const user = await makeUser();
  const started = await createDeviceAuthorization({
    deviceName: 'my-laptop',
    ipAddress: '10.0.0.1',
    userAgent: 'rb/1',
    now: T0
  });
  await decideDeviceAuthorization({ userCode: started.data.userCode, approve: true, ...user, now: T0 + 1000 });
  const polled = await pollDeviceAuthorization({ deviceCode: started.data.deviceCode, now: T0 + 2000 });
  assert.equal(polled.data.status, 'issued');
  assert.ok(isWellFormedCliToken(polled.data.token));
  assert.equal(CLI_SESSION_DAYS, 30);
  assert.equal(polled.data.expiresIn, 30 * 24 * 60 * 60);
  const { session } = polled.data;
  assert.match(session.publicId, /^C[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
  assert.equal(session.name, 'CLI on my-laptop');
  assert.equal(session.workspaceId, user.workspaceId);
  assert.equal(session.creatorUserId, user.userId);
  assert.equal(session.deviceName, 'my-laptop');
  assert.equal(session.ipAddress, '10.0.0.1');
  assert.equal(session.userAgent, 'rb/1');
  assert.equal(session.expiresTimestamp, T0 + 2000 + 30 * DAY_MS);
  const again = await pollDeviceAuthorization({ deviceCode: started.data.deviceCode, now: T0 + 10_000 });
  assert.equal(again.data.status, 'expired', 'the token is returned only once');
});

test('decideDeviceAuthorization cannot change a decided login', async () => {
  const user = await makeUser();
  const started = await createDeviceAuthorization({ now: T0 });
  const { userCode } = started.data;
  assert.equal((await decideDeviceAuthorization({ userCode, approve: false, now: T0 + 1 })).data, true);
  assert.equal((await decideDeviceAuthorization({ userCode, approve: true, ...user, now: T0 + 2 })).data, false);
});

test('a session is found by its token, listed, and deleted', async () => {
  const user = await makeUser();
  const { token, session } = await login(user);
  assert.equal((await findCliSessionByToken({ token })).data.publicId, session.publicId);
  assert.equal((await listCliSessionsByUser({ ...user, now: T0 + 3000 })).data.length, 1);
  const listed = await listCliSessionsByWorkspace({ workspaceId: user.workspaceId, now: T0 + 3000 });
  assert.equal(listed.data[0].creatorEmail, 'user@example.com');
  const shown = await getCliSessionByPublicId({
    workspaceId: user.workspaceId,
    publicId: session.publicId,
    now: T0 + 3000
  });
  assert.equal(shown.data.name, 'CLI on my-laptop');
  assert.equal((await deleteCliSession({ workspaceId: user.workspaceId, publicId: session.publicId })).data, true);
  assert.equal((await findCliSessionByToken({ token })).data, null);
});

test('an expired session is not listed, but its token is still found', async () => {
  const user = await makeUser();
  const { token } = await login(user);
  const later = T0 + 31 * DAY_MS;
  assert.equal((await listCliSessionsByUser({ ...user, now: later })).data.length, 0);
  assert.ok((await findCliSessionByToken({ token })).data);
});

test('deleteCliSessionByToken revokes the token that is sent', async () => {
  const user = await makeUser();
  const { token } = await login(user);
  assert.equal((await deleteCliSessionByToken({ token })).data, true);
  assert.equal((await deleteCliSessionByToken({ token })).data, false);
});

test('recordCliSessionUse writes at most once a minute', async () => {
  const user = await makeUser();
  const { session } = await login(user);
  assert.equal((await recordCliSessionUse({ cliSessionId: session.cliSessionId, now: T0 + 10_000 })).data, true);
  assert.equal((await recordCliSessionUse({ cliSessionId: session.cliSessionId, now: T0 + 20_000 })).data, false);
  assert.equal((await recordCliSessionUse({ cliSessionId: session.cliSessionId, now: T0 + 80_000 })).data, true);
});

test('cleanupCliSessions removes expired logins, and sessions long past expiry', async () => {
  const user = await makeUser();
  await login(user);
  await createDeviceAuthorization({ now: T0 });
  // The login rows are past their 15 minutes; the session is not yet expired.
  assert.equal((await cleanupCliSessions({ now: T0 + DAY_MS })).data, 2);
  // Kept a while after expiry, so its owner learns why it fails.
  assert.equal((await cleanupCliSessions({ now: T0 + 31 * DAY_MS })).data, 0);
  assert.equal((await cleanupCliSessions({ now: T0 + 61 * DAY_MS })).data, 1);
});

test('createDeviceAuthorization stops one address after DEVICE_LIMIT_PER_IP logins', async () => {
  const { DEVICE_LIMIT_PER_IP } = await import('./cli.js');
  for (let i = 0; i < DEVICE_LIMIT_PER_IP; i += 1) {
    assert.ok((await createDeviceAuthorization({ ipAddress: '203.0.113.1' })).data);
  }
  assert.equal((await createDeviceAuthorization({ ipAddress: '203.0.113.1' })).error, 'DEVICE_RATE_LIMITED');
  assert.ok((await createDeviceAuthorization({ ipAddress: '203.0.113.2' })).data);
});

test('createDeviceAuthorization stops everyone after DEVICE_LIMIT_TOTAL logins', async () => {
  const { DEVICE_LIMIT_TOTAL } = await import('./cli.js');
  for (let i = 0; i < DEVICE_LIMIT_TOTAL; i += 1) {
    assert.ok((await createDeviceAuthorization({ ipAddress: `10.0.${Math.floor(i / 5)}.${i % 5}` })).data);
  }
  assert.equal((await createDeviceAuthorization({ ipAddress: '203.0.113.9' })).error, 'DEVICE_RATE_LIMITED');
});

test('createDeviceAuthorization lets exactly DEVICE_LIMIT_PER_IP of parallel starts from one address succeed', async () => {
  const { DEVICE_LIMIT_PER_IP } = await import('./cli.js');
  const results = await Promise.all(
    Array.from({ length: 50 }, () => createDeviceAuthorization({ ipAddress: '203.0.113.1' }))
  );
  assert.equal(results.filter((r) => r.data).length, DEVICE_LIMIT_PER_IP);
});

test('createDeviceAuthorization counts only logins started within the window', async () => {
  const { DEVICE_LIMIT_PER_IP, DEVICE_LIMIT_WINDOW_MS } = await import('./cli.js');
  for (let i = 0; i < DEVICE_LIMIT_PER_IP; i += 1)
    await createDeviceAuthorization({ ipAddress: '203.0.113.1', now: T0 });
  const later = T0 + DEVICE_LIMIT_WINDOW_MS + 1;
  assert.ok((await createDeviceAuthorization({ ipAddress: '203.0.113.1', now: later })).data);
});
