import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Set before the routes pull in ../../config, which freezes what it read. No
// external fleet: suspend and resume exist only for local VMs.
process.env.BROWSERFLEET_URL = '';
process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./suspend.js');
const { routes: showRoutes } = await import('./show.js');
const { setVmClient } = await import('../../vm/index.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const {
  launchBrowserInstance,
  recordProvisionedBrowser,
  getBrowserInstance,
  updateBrowserInstanceStatus,
  transitionBrowserInstanceStatus
} = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.use((c, next) => {
    c.set('secureHeadersNonce', 'test-nonce-value');
    return next();
  });
  app.route('/browsers', routes);
  app.route('/browsers', showRoutes);
  return app;
};

// A fake VM client that records calls and can be told to fail, so no QEMU is
// needed. With no CDP URL, the monitor started after a resume gives up at once
// instead of dialing.
const fakeVms = (overrides = {}) => {
  const calls = [];
  const record = (name, result) => async (args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return result;
  };
  setVmClient({
    suspendBrowser: record('suspendBrowser', undefined),
    resumeBrowser: record('resumeBrowser', { browserId: 'Qabc12345' }),
    browserIsRunning: record('browserIsRunning', true),
    resolveCdpUrl: record('resolveCdpUrl', null),
    ...overrides
  });
  return calls;
};
const names = (calls) => calls.map(({ name }) => name);

let userId;
let userPublicId;

const cookie = () =>
  `session=${createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now() })}; csrf_id=${'a'.repeat(32)}`;
const csrfToken = () => {
  const expires = Date.now() + 15 * 60 * 1000;
  return `${expires}.${sign(`csrf.${'a'.repeat(32)}.${expires}`)}`;
};

const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const workspace = await ensurePersonalWorkspace({ userId, email: 'user@example.com', personalWorkspaceId: null });
  return workspace.data.workspaceId;
};

// A provisioned browser in `status`, created by `creatorId` (the signed-in user by default).
const makeBrowser = async (workspaceId, { status = 'running', creatorId = userId } = {}) => {
  const launched = await launchBrowserInstance({ workspaceId, userId: creatorId, browserName: 'calm-otter' });
  const { browserInstanceId, publicId } = launched.data;
  await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId: 'Qabc12345', userId: creatorId });
  await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: 'running' });
  if (status === 'suspended') {
    await transitionBrowserInstanceStatus({
      workspaceId,
      browserInstanceId,
      fromStatuses: ['running'],
      toStatus: 'suspended'
    });
  }
  const statusNow = async () => (await getBrowserInstance({ workspaceId, browserInstanceId })).data.status;
  return { publicId, statusNow };
};

const post = (app, path, workspaceId, { csrf = csrfToken(), htmx = false } = {}) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': cookie(),
      ...(htmx && { 'hx-request': 'true' })
    },
    body: new URLSearchParams({ workspace: workspaceId, csrf }).toString()
  });

test('GET /browsers/:browserId/suspend asks to confirm, without the warning that terminating has', async () => {
  const workspaceId = await makeUser();
  const { publicId } = await makeBrowser(workspaceId);
  const res = await setupApp().request(`/browsers/${publicId}/suspend`, { headers: { cookie: cookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Suspending <strong>calm-otter<\/strong>/);
  assert.doesNotMatch(body, /cannot be undone/i);
  assert.doesNotMatch(body, /name="name"/);
  assert.match(body, new RegExp(`action="/browsers/${publicId}/suspend"`));
  assert.match(body, new RegExp(`name="workspace" value="${workspaceId}"`));
  assert.match(body, /<button type="submit" class="btn-primary">Suspend</);
  assert.match(body, new RegExp(`hx-post="/browsers/${publicId}/suspend"`));
  assert.match(body, /class="busy-message" role="status">Suspending\.\.\.</);
  assert.match(body, /<script nonce="test-nonce-value">/);
  assert.match(body, new RegExp(`href="/browsers/${publicId}" class="btn-secondary">Cancel`));
});

test('GET /browsers/:browserId/suspend sends a browser that is not running back to its page', async () => {
  const workspaceId = await makeUser();
  const { publicId } = await makeBrowser(workspaceId, { status: 'suspended' });
  const res = await setupApp().request(`/browsers/${publicId}/suspend`, { headers: { cookie: cookie() } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/browsers/${publicId}`);
});

test('POST /browsers/:browserId/suspend suspends the VM and marks the browser suspended', async () => {
  const workspaceId = await makeUser();
  const { publicId, statusNow } = await makeBrowser(workspaceId);
  const calls = fakeVms();
  const res = await post(setupApp(), `/browsers/${publicId}/suspend`, workspaceId);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/browsers/${publicId}`);
  assert.deepEqual(calls, [{ name: 'suspendBrowser', args: 'Qabc12345' }]);
  assert.equal(await statusNow(), 'suspended');
});

test('POST /browsers/:browserId/suspend from htmx redirects to the browser page', async () => {
  const workspaceId = await makeUser();
  const { publicId, statusNow } = await makeBrowser(workspaceId);
  fakeVms();
  const res = await post(setupApp(), `/browsers/${publicId}/suspend`, workspaceId, { htmx: true });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('hx-redirect'), `/browsers/${publicId}`);
  assert.equal(await statusNow(), 'suspended');
});

test('a failed suspend keeps the browser running and says so', async () => {
  const workspaceId = await makeUser();
  const { publicId, statusNow } = await makeBrowser(workspaceId);
  fakeVms({ suspendBrowser: async () => Promise.reject(new Error('saving the VM state failed')) });
  const res = await post(setupApp(), `/browsers/${publicId}/suspend`, workspaceId);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Unable to suspend the browser/);
  assert.equal(await statusNow(), 'running');
});

test('POST /browsers/:browserId/suspend refuses a bad CSRF token and a browser that is not running', async () => {
  const workspaceId = await makeUser();
  const running = await makeBrowser(workspaceId);
  const suspended = await makeBrowser(workspaceId, { status: 'suspended' });
  const calls = fakeVms();
  const app = setupApp();
  assert.equal((await post(app, `/browsers/${running.publicId}/suspend`, workspaceId, { csrf: 'bogus' })).status, 403);
  const again = await post(app, `/browsers/${suspended.publicId}/suspend`, workspaceId);
  assert.equal(again.status, 409);
  assert.match(await again.text(), /not running, so it cannot be suspended/);
  assert.deepEqual(calls, []);
  assert.equal(await running.statusNow(), 'running');
});

test('POST /browsers/:browserId/resume resumes the VM, marks it running, and watches it again', async () => {
  const workspaceId = await makeUser();
  const { publicId, statusNow } = await makeBrowser(workspaceId, { status: 'suspended' });
  const calls = fakeVms();
  const res = await post(setupApp(), `/browsers/${publicId}/resume`, workspaceId);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/browsers/${publicId}`);
  assert.equal(await statusNow(), 'running');
  // The monitor asks for the CDP URL, which may have moved to a new port.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(names(calls), ['resumeBrowser', 'resolveCdpUrl', 'browserIsRunning']);
});

test('POST /browsers/:browserId/resume from htmx redirects to the browser page', async () => {
  const workspaceId = await makeUser();
  const { publicId, statusNow } = await makeBrowser(workspaceId, { status: 'suspended' });
  fakeVms();
  const res = await post(setupApp(), `/browsers/${publicId}/resume`, workspaceId, { htmx: true });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('hx-redirect'), `/browsers/${publicId}`);
  assert.equal(await statusNow(), 'running');
});

test('a failed resume keeps the browser suspended and shows the error on its page', async () => {
  const workspaceId = await makeUser();
  const { publicId, statusNow } = await makeBrowser(workspaceId, { status: 'suspended' });
  fakeVms({ resumeBrowser: async () => Promise.reject(new Error('Unable to resume chromium-Qabc12345')) });
  const res = await post(setupApp(), `/browsers/${publicId}/resume`, workspaceId);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /role="alert" class="danger">Unable to resume the browser/);
  assert.match(body, /<strong>Status:<\/strong> suspended/);
  assert.equal(await statusNow(), 'suspended');
});

test('POST /browsers/:browserId/resume leaves a browser that is not suspended alone', async () => {
  const workspaceId = await makeUser();
  const { publicId } = await makeBrowser(workspaceId);
  const calls = fakeVms();
  const res = await post(setupApp(), `/browsers/${publicId}/resume`, workspaceId);
  assert.equal(res.status, 303);
  assert.deepEqual(calls, []);
});

test('only the creator, an Admin, or the Owner may suspend or resume a browser', async () => {
  await makeUser();
  const owner = await findOrCreateUser({ email: 'owner@example.com' });
  const creator = await findOrCreateUser({ email: 'creator@example.com' });
  const workspace = await createWorkspace({ name: 'Acme Corp', ownerId: owner.data.id });
  const workspaceId = workspace.data.workspaceId;
  await createCollaborator({
    workspaceId,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });
  const running = await makeBrowser(workspaceId, { creatorId: creator.data.id });
  const suspended = await makeBrowser(workspaceId, { creatorId: creator.data.id, status: 'suspended' });
  const calls = fakeVms();
  const app = setupApp();
  const withWorkspace = () =>
    `session=${createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), activeWorkspaceId: workspaceId })}; csrf_id=${'a'.repeat(32)}`;
  const request = (path, method = 'POST') =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': withWorkspace() },
      body:
        method === 'POST' ? new URLSearchParams({ workspace: workspaceId, csrf: csrfToken() }).toString() : undefined
    });
  assert.equal((await request(`/browsers/${running.publicId}/suspend`, 'GET')).status, 403);
  assert.equal((await request(`/browsers/${running.publicId}/suspend`)).status, 403);
  assert.equal((await request(`/browsers/${suspended.publicId}/resume`)).status, 403);
  assert.deepEqual(calls, []);
  // Nor do they see the controls.
  const page = await (await request(`/browsers/${running.publicId}`, 'GET')).text();
  assert.doesNotMatch(page, />Suspend</);
});

test("a running browser's page offers Suspend and Terminate", async () => {
  const workspaceId = await makeUser();
  const { publicId } = await makeBrowser(workspaceId);
  // The page lists the browser's tabs over CDP; none here.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  fakeVms({ resolveCdpUrl: async () => 'ws://127.0.0.1:9/devtools/browser/x' });
  try {
    const body = await (await setupApp().request(`/browsers/${publicId}`, { headers: { cookie: cookie() } })).text();
    assert.match(body, new RegExp(`href="/browsers/${publicId}/suspend" class="btn-secondary">Suspend`));
    assert.match(body, new RegExp(`href="/browsers/${publicId}/terminate" class="btn-danger">Terminate`));
    assert.doesNotMatch(body, />Resume</);
  } finally {
    globalThis.fetch = original;
  }
});

test("a suspended browser's page says so, and offers Resume and Terminate", async () => {
  const workspaceId = await makeUser();
  const { publicId } = await makeBrowser(workspaceId, { status: 'suspended' });
  const body = await (await setupApp().request(`/browsers/${publicId}`, { headers: { cookie: cookie() } })).text();
  assert.match(body, /<strong>Status:<\/strong> suspended/);
  assert.match(body, /This browser is suspended/);
  assert.match(body, new RegExp(`action="/browsers/${publicId}/resume"`));
  assert.match(body, /<button type="submit" class="btn-primary">Resume</);
  assert.match(body, new RegExp(`hx-post="/browsers/${publicId}/resume"`));
  assert.match(body, /class="busy-message" role="status">Resuming\.\.\.</);
  assert.match(body, new RegExp(`href="/browsers/${publicId}/terminate" class="btn-danger">Terminate`));
  assert.doesNotMatch(body, />Suspend</);
  // No connection details while it cannot be reached.
  assert.doesNotMatch(body, /class="instruction-block"/);
});
