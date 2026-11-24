import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { routes } = await import('./auth.js');
const { routes: browserRoutes } = await import('./browsers.js');
const { decideDeviceAuthorization, findCliSessionByToken } = await import('../../models/cli.js');
const { normalizeUserCode } = await import('../../cli.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { getDatabase, closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/api/v1/auth', routes);
  app.route('/api/v1/browsers', browserRoutes);
  return app;
};

const postJson = (app, path, body, headers = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, workspaceId: workspace.data.workspaceId };
};

// Lets the next poll through, as if the CLI had waited its interval.
const forgetLastPoll = async () =>
  (await getDatabase()).query('UPDATE device_authorizations SET last_polled_timestamp=NULL');

test('POST /device starts a login with the RFC 8628 fields', async () => {
  const res = await postJson(setupApp(), 'http://localhost/api/v1/auth/device', {
    client_id: 'remotebrowser-cli',
    device_name: 'my-laptop',
    days: 30
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.device_code.length >= 43);
  assert.match(body.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(body.verification_uri, 'http://localhost/activate');
  assert.equal(body.verification_uri_complete, `http://localhost/activate?code=${body.user_code}`);
  assert.equal(body.expires_in, 900);
  assert.equal(body.interval, 5);
});

test('POST /token walks through pending, approval, and a single issue', async () => {
  const app = setupApp();
  const user = await makeUser();
  const started = await (await postJson(app, '/api/v1/auth/device', { device_name: 'my-laptop' })).json();
  const poll = () => postJson(app, '/api/v1/auth/token', { grant_type: GRANT, device_code: started.device_code });

  let res = await poll();
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'authorization_pending' });

  res = await poll();
  assert.deepEqual(await res.json(), { error: 'slow_down' });

  await decideDeviceAuthorization({ userCode: normalizeUserCode(started.user_code), approve: true, ...user });
  await forgetLastPoll();
  res = await poll();
  assert.equal(res.status, 200);
  const issued = await res.json();
  assert.match(issued.access_token, /^rb-cli-/);
  assert.equal(issued.token_type, 'Bearer');
  assert.equal(issued.expires_in, 30 * 24 * 60 * 60);

  await forgetLastPoll();
  res = await poll();
  assert.deepEqual(await res.json(), { error: 'expired_token' });

  // The token works where an API key does.
  const listed = await app.request('/api/v1/browsers', { headers: { Authorization: `Bearer ${issued.access_token}` } });
  assert.equal(listed.status, 200);
});

test('POST /token says access_denied after a denial', async () => {
  const app = setupApp();
  const started = await (await postJson(app, '/api/v1/auth/device', {})).json();
  await decideDeviceAuthorization({ userCode: normalizeUserCode(started.user_code), approve: false });
  const res = await postJson(app, '/api/v1/auth/token', { grant_type: GRANT, device_code: started.device_code });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'access_denied' });
});

test('POST /token refuses another grant type and an unknown code', async () => {
  const app = setupApp();
  let res = await postJson(app, '/api/v1/auth/token', { grant_type: 'password' });
  assert.deepEqual(await res.json(), { error: 'unsupported_grant_type' });
  res = await postJson(app, '/api/v1/auth/token', { grant_type: GRANT, device_code: 'nope' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'expired_token' });
});

test('POST /revoke ends the session of the token that is sent', async () => {
  const app = setupApp();
  const user = await makeUser();
  const started = await (await postJson(app, '/api/v1/auth/device', {})).json();
  await decideDeviceAuthorization({ userCode: normalizeUserCode(started.user_code), approve: true, ...user });
  const { access_token: token } = await (
    await postJson(app, '/api/v1/auth/token', { grant_type: GRANT, device_code: started.device_code })
  ).json();
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await postJson(app, '/api/v1/auth/revoke', {}, auth)).status, 204);
  assert.equal((await findCliSessionByToken({ token })).data, null);
  assert.equal((await postJson(app, '/api/v1/auth/revoke', {}, auth)).status, 401);
  assert.equal((await app.request('/api/v1/browsers', { headers: auth })).status, 401);
});

test('an expired CLI token gets "Your login has expired."', async () => {
  const app = setupApp();
  const user = await makeUser();
  const started = await (await postJson(app, '/api/v1/auth/device', {})).json();
  await decideDeviceAuthorization({ userCode: normalizeUserCode(started.user_code), approve: true, ...user });
  const { access_token: token } = await (
    await postJson(app, '/api/v1/auth/token', { grant_type: GRANT, device_code: started.device_code })
  ).json();
  await (await getDatabase()).query('UPDATE cli_sessions SET expires_timestamp=created_timestamp+1');
  const res = await app.request('/api/v1/browsers', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Your login has expired.' });
});

test('POST /device answers 429 with Retry-After when the limit is reached', async () => {
  const { createDeviceAuthorization, DEVICE_LIMIT_PER_IP } = await import('../../models/cli.js');
  for (let i = 0; i < DEVICE_LIMIT_PER_IP; i += 1) await createDeviceAuthorization({ ipAddress: '203.0.113.1' });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('ipAddress', '203.0.113.1');
    await next();
  });
  app.route('/api/v1/auth', routes);
  const res = await postJson(app, 'http://localhost/api/v1/auth/device', {});
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '600');
});
