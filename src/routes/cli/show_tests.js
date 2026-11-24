import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { routes } = await import('./show.js');
const { routes: homepage } = await import('../homepage.js');
const { createDeviceAuthorization, decideDeviceAuthorization, pollDeviceAuthorization, findCliSessionByToken } =
  await import('../../models/cli.js');
const { authenticateApiKey } = await import('../../middleware/apikey.js');
const { onRecheckApiSessions } = await import('../api/sessions.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/cli', routes);
  app.route('/', homepage);
  return app;
};

const CSRF_ID = 'a'.repeat(32);
const csrfToken = () => {
  const expires = Date.now() + 15 * 60 * 1000;
  return `${expires}.${sign(`csrf.${CSRF_ID}.${expires}`)}`;
};

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, publicId: created.data.publicId, email, workspaceId: workspace.data.workspaceId };
};

const cookieFor = (user) =>
  `session=${createSessionCookie({ publicId: user.publicId, email: user.email, issuedAt: Date.now() })}; csrf_id=${CSRF_ID}`;

const login = async (user) => {
  const started = await createDeviceAuthorization({
    deviceName: 'my-laptop',
    ipAddress: '10.0.0.1',
    userAgent: 'remotebrowser-cli/1.2.3'
  });
  await decideDeviceAuthorization({
    userCode: started.data.userCode,
    approve: true,
    userId: user.userId,
    workspaceId: user.workspaceId
  });
  return (await pollDeviceAuthorization({ deviceCode: started.data.deviceCode })).data;
};

const get = (path, user) => setupApp().request(path, { headers: { cookie: cookieFor(user) } });

test('the workspace page lists the active CLI sessions', async () => {
  const user = await makeUser();
  const { session } = await login(user);
  const body = await (await get('/', user)).text();
  assert.match(body, /<h2>CLI Sessions<\/h2>/);
  assert.match(body, new RegExp(`<a href="/cli/${session.publicId}">CLI on my-laptop</a>`));
});

test('the workspace page links to the CLI guide when there is no CLI session', async () => {
  const user = await makeUser();
  const body = await (await get('/', user)).text();
  assert.match(body, /No active sessions for the/);
  assert.match(body, /<a href="https:\/\/remotebrowser.ai\/cli\/">CLI<\/a>/);
});

test('GET /cli/:id shows what is known about the session and a Revoke button', async () => {
  const user = await makeUser();
  const { session } = await login(user);
  const res = await get(`/cli/${session.publicId}`, user);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<h1>CLI on my-laptop<\/h1>/);
  assert.match(body, /by user@example\.com/);
  assert.match(body, /in 30 days/);
  assert.match(body, /10\.0\.0\.1/);
  assert.match(body, /remotebrowser-cli\/1\.2\.3/);
  assert.match(body, /Never/);
  assert.match(body, /<button type="submit" class="btn-danger">Revoke<\/button>/);
});

test('GET /cli/:id hides another user’s session', async () => {
  const user = await makeUser();
  const other = await makeUser('other@example.com');
  const { session } = await login(other);
  assert.equal((await get(`/cli/${session.publicId}`, user)).status, 404);
});

test('POST /cli/:id/revoke stops the token at once', async () => {
  const user = await makeUser();
  const { session, token } = await login(user);
  let rechecks = 0;
  const stop = onRecheckApiSessions(() => {
    rechecks += 1;
  });
  const res = await setupApp().request(`/cli/${session.publicId}/revoke`, {
    method: 'POST',
    headers: { 'cookie': cookieFor(user), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: csrfToken(), workspace: String(user.workspaceId) }).toString()
  });
  stop();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(rechecks, 1);
  assert.equal((await findCliSessionByToken({ token })).data, null);
  assert.equal((await authenticateApiKey(`Bearer ${token}`)).error, 'UNAUTHORIZED');
});

test('POST /cli/:id/revoke needs a valid CSRF token', async () => {
  const user = await makeUser();
  const { session, token } = await login(user);
  const res = await setupApp().request(`/cli/${session.publicId}/revoke`, {
    method: 'POST',
    headers: { 'cookie': cookieFor(user), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'bad', workspace: String(user.workspaceId) }).toString()
  });
  assert.equal(res.status, 403);
  assert.ok((await findCliSessionByToken({ token })).data);
});
