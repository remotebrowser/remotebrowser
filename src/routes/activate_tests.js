import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../auth/session.js');
const { sign } = await import('../auth/signing.js');
const { routes } = await import('./activate.js');
const { createDeviceAuthorization, pollDeviceAuthorization } = await import('../models/cli.js');
const { formatUserCode } = await import('../cli.js');
const { findOrCreateUser } = await import('../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../models/workspaces.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/activate', routes);
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

const joinShared = async (user, workspaceId = 4444) => {
  await createWorkspace({ name: 'Acme', ownerId: user.userId, workspaceId });
  await createCollaborator({
    workspaceId,
    userId: user.userId,
    email: user.email,
    role: 'User',
    workspaceName: 'Acme'
  });
  return workspaceId;
};

const cookieFor = (user) =>
  `session=${createSessionCookie({ publicId: user.publicId, email: user.email, issuedAt: Date.now() })}; csrf_id=${CSRF_ID}`;

const post = (path, user, fields) =>
  setupApp().request(path, {
    method: 'POST',
    headers: { 'cookie': cookieFor(user), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: csrfToken(), ...fields }).toString()
  });

const startLogin = async () =>
  (await createDeviceAuthorization({ deviceName: 'my-laptop', ipAddress: '10.0.0.1' })).data;

test('GET /activate sends a signed-out visitor to sign in, keeping the code', async () => {
  const res = await setupApp().request('/activate?code=bdfghjkl');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('return_to=')));
});

test('GET /activate?code= fills in the code but asks the user to check it', async () => {
  const user = await makeUser();
  const res = await setupApp().request('/activate?code=bdfghjkl', { headers: { cookie: cookieFor(user) } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /value="BDFG-HJKL"/);
  assert.match(body, /Check that this code matches the code in your terminal/);
  assert.doesNotMatch(body, /Approve/);
});

test('POST /activate refuses a wrong code', async () => {
  const user = await makeUser();
  const res = await post('/activate', user, { code: 'BBBB-BBBB' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /wrong or has expired/);
});

test('POST /activate shows the login, without a workspace choice for a user with only their own', async () => {
  const user = await makeUser();
  const login = await startLogin();
  const res = await post('/activate', user, { code: login.userCode.toLowerCase() });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(formatUserCode(login.userCode)));
  assert.match(body, /my-laptop/);
  assert.match(body, /10\.0\.0\.1/);
  assert.match(body, /<strong>30 days<\/strong>/);
  assert.doesNotMatch(body, /<select/);
  assert.match(body, new RegExp(`name="workspace" value="${user.workspaceId}"`));
});

test('POST /activate asks which workspace when the user has several', async () => {
  const user = await makeUser();
  await joinShared(user);
  const login = await startLogin();
  const body = await (await post('/activate', user, { code: login.userCode })).text();
  assert.match(body, /<select id="workspace" name="workspace"/);
  assert.match(body, /Personal workspace/);
  assert.match(body, /Acme/);
});

test('POST /activate/decide approves for the chosen workspace', async () => {
  const user = await makeUser();
  const sharedId = await joinShared(user);
  const login = await startLogin();
  const res = await post('/activate/decide', user, {
    code: login.userCode,
    decision: 'approve',
    workspace: String(sharedId)
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /CLI login approved/);
  const polled = await pollDeviceAuthorization({ deviceCode: login.deviceCode });
  assert.equal(polled.data.status, 'issued');
  assert.equal(polled.data.session.workspaceId, sharedId);
  assert.equal(polled.data.session.creatorUserId, user.userId);
});

test('POST /activate/decide refuses a workspace the user does not belong to', async () => {
  const user = await makeUser();
  const other = await makeUser('other@example.com');
  const login = await startLogin();
  const res = await post('/activate/decide', user, {
    code: login.userCode,
    decision: 'approve',
    workspace: String(other.workspaceId)
  });
  assert.equal(res.status, 400);
  assert.equal((await pollDeviceAuthorization({ deviceCode: login.deviceCode })).data.status, 'pending');
});

test('POST /activate/decide denies', async () => {
  const user = await makeUser();
  const login = await startLogin();
  const res = await post('/activate/decide', user, { code: login.userCode, decision: 'deny' });
  assert.match(await res.text(), /CLI login denied/);
  assert.equal((await pollDeviceAuthorization({ deviceCode: login.deviceCode })).data.status, 'denied');
});

test('POST /activate/decide needs a valid CSRF token', async () => {
  const user = await makeUser();
  const login = await startLogin();
  const res = await post('/activate/decide', user, {
    code: login.userCode,
    decision: 'approve',
    workspace: String(user.workspaceId),
    csrf: 'bad'
  });
  assert.equal(res.status, 403);
  assert.equal((await pollDeviceAuthorization({ deviceCode: login.deviceCode })).data.status, 'pending');
});
