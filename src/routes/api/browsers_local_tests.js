import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Set before the routes pull in ../../config, which freezes what it read. No
// external fleet: suspend and resume exist only for local VMs.
process.env.BROWSERFLEET_URL = '';
process.env.PGLITE_DATA_DIR = 'memory://';

const { routes } = await import('./browsers.js');
const { setVmClient } = await import('../../vm/index.js');
const { createApiKey } = await import('../../models/apikeys.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const {
  launchBrowserInstance,
  recordProvisionedBrowser,
  updateBrowserInstanceStatus,
  getBrowserInstanceByPublicId,
  listBrowserInstancesByWorkspace
} = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/api/v1/browsers', routes);
  return app;
};

// A fake VM client that records calls and can be told to fail, so no QEMU is
// needed. With no CDP URL, the preview capture and the monitor give up at once.
const fakeVms = (overrides = {}) => {
  const calls = [];
  const record = (name, result) => async (args) => {
    calls.push(name);
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

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, workspaceId: workspace.data.workspaceId };
};

const makeKey = async ({ workspaceId, userId }) =>
  (await createApiKey({ workspaceId, userId, name: 'test', expiration: '1d' })).data.apiKey;

const makeBrowser = async ({ workspaceId, userId, status = 'running' }) => {
  const launched = await launchBrowserInstance({ workspaceId, userId, browserName: 'calm-otter' });
  const { browserInstanceId, publicId } = launched.data;
  await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId: 'Qabc12345', userId });
  await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: status });
  return publicId;
};

const post = (path, apiKey) =>
  setupApp().request(path, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` } });

const statusOf = async (workspaceId, publicId) =>
  (await getBrowserInstanceByPublicId({ workspaceId, publicId })).data.status;

test('POST /suspend then /resume moves a browser from running to suspended and back', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const calls = fakeVms();

  const suspended = await post(`/api/v1/browsers/${publicId}/suspend`, apiKey);
  assert.equal(suspended.status, 200);
  assert.deepEqual(await suspended.json(), { browser_id: publicId, status: 'suspended' });
  assert.equal(await statusOf(workspaceId, publicId), 'suspended');

  const resumed = await post(`/api/v1/browsers/${publicId}/resume`, apiKey);
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), { browser_id: publicId, status: 'running' });
  assert.equal(await statusOf(workspaceId, publicId), 'running');
  assert.ok(calls.includes('suspendBrowser') && calls.includes('resumeBrowser'));
});

test('POST /suspend and /resume answer 409 for a browser in the wrong state', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const running = await makeBrowser({ workspaceId, userId });
  const suspended = await makeBrowser({ workspaceId, userId, status: 'suspended' });
  const calls = fakeVms();

  const resume = await post(`/api/v1/browsers/${running}/resume`, apiKey);
  assert.equal(resume.status, 409);
  assert.deepEqual(await resume.json(), {
    error: 'Only a suspended browser can be resumed.',
    browser_id: running,
    status: 'running'
  });
  const suspend = await post(`/api/v1/browsers/${suspended}/suspend`, apiKey);
  assert.equal(suspend.status, 409);
  assert.deepEqual(await suspend.json(), {
    error: 'Only a running browser can be suspended.',
    browser_id: suspended,
    status: 'suspended'
  });
  assert.deepEqual(calls, []);
});

test('POST /suspend answers 502 and keeps the browser running when the VM fails', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  fakeVms({ suspendBrowser: async () => Promise.reject(new Error('saving the VM state failed')) });
  const res = await post(`/api/v1/browsers/${publicId}/suspend`, apiKey);
  assert.equal(res.status, 502);
  assert.equal(await statusOf(workspaceId, publicId), 'running');
});

test('POST /suspend and /resume answer 404 for a browser outside the key’s workspace', async () => {
  const { userId, workspaceId } = await makeUser();
  const other = await makeUser('other@example.com');
  const apiKey = await makeKey({ workspaceId, userId });
  const theirs = await makeBrowser({ workspaceId: other.workspaceId, userId: other.userId });
  fakeVms();
  for (const action of ['suspend', 'resume']) {
    const res = await post(`/api/v1/browsers/${theirs}/${action}`, apiKey);
    assert.equal(res.status, 404, action);
  }
  assert.equal(await statusOf(other.workspaceId, theirs), 'running');
});

test('POST /suspend answers 403 to a User who did not create the browser', async () => {
  const owner = await makeUser('owner@example.com');
  const { userId } = await makeUser();
  await createWorkspace({ name: 'Acme', ownerId: owner.userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme'
  });
  const apiKey = await makeKey({ workspaceId: 3333, userId });
  const publicId = await makeBrowser({ workspaceId: 3333, userId: owner.userId });
  fakeVms();
  const res = await post(`/api/v1/browsers/${publicId}/suspend`, apiKey);
  assert.equal(res.status, 403);
  assert.equal(await statusOf(3333, publicId), 'running');
});

test('POST /suspend and /resume answer 401 without an API key', async () => {
  for (const action of ['suspend', 'resume']) {
    const res = await setupApp().request(`/api/v1/browsers/Bxxxxxx/${action}`, { method: 'POST' });
    assert.equal(res.status, 401, action);
  }
});

const sendJson = (method, path, apiKey, body) =>
  setupApp().request(path, {
    method,
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

// Records the proxy each call hands the VM, as the guest would get it.
const fakeProxyVms = (overrides = {}) => {
  const proxies = [];
  fakeVms({
    setProxy: async (_browserId, proxy) => proxies.push(proxy),
    clearProxy: async () => proxies.push(null),
    ...overrides
  });
  return proxies;
};

test('PATCH /:id/config sets the proxy, and GET reports it with the password hidden', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const proxies = fakeProxyVms();
  const path = `/api/v1/browsers/${publicId}/config`;

  const res = await sendJson('PATCH', path, apiKey, { proxy: 'http://user:secret@Proxy.example.com:8080' });
  assert.equal(res.status, 200);
  const expected = { browser_id: publicId, proxy: 'http://user:****@proxy.example.com:8080' };
  assert.deepEqual(await res.json(), expected);
  assert.deepEqual(proxies, ['http://user:secret@proxy.example.com:8080'], 'the VM gets the real password');

  const read = await setupApp().request(path, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.deepEqual(await read.json(), expected);
  assert.ok(!JSON.stringify(await getBrowserInstanceByPublicId({ workspaceId, publicId })).includes('secret'));
});

test('PATCH /:id/config with a null proxy connects directly again', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const proxies = fakeProxyVms();
  const path = `/api/v1/browsers/${publicId}/config`;
  await sendJson('PATCH', path, apiKey, { proxy: 'socks5://proxy.example.com:1080' });
  const res = await sendJson('PATCH', path, apiKey, { proxy: null });
  assert.deepEqual(await res.json(), { browser_id: publicId, proxy: null });
  assert.deepEqual(proxies, ['socks5://proxy.example.com:1080', null]);
});

test('PATCH /:id/config with no settings changes nothing', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const proxies = fakeProxyVms();
  const res = await sendJson('PATCH', `/api/v1/browsers/${publicId}/config`, apiKey, {});
  assert.deepEqual(await res.json(), { browser_id: publicId, proxy: null });
  assert.deepEqual(proxies, []);
});

test('PATCH /:id/config refuses a bad body or proxy URL, and changes nothing', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const proxies = fakeProxyVms();
  for (const [body, message] of [
    ['not json', 'The request body must be JSON.'],
    ['[1]', 'The request body must be a JSON object.'],
    [{ denylist: [] }, 'Unknown setting: denylist.'],
    [{ proxy: 42 }, 'The proxy must be a URL, or null to connect directly.'],
    [{ proxy: 'https://proxy.example.com' }, 'The proxy URL must start with http://, socks4://, or socks5://.']
  ]) {
    const res = await sendJson('PATCH', `/api/v1/browsers/${publicId}/config`, apiKey, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: message });
  }
  assert.deepEqual(proxies, []);
});

test('PATCH /:id/config answers 409 for a browser that is not running', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId, status: 'suspended' });
  const proxies = fakeProxyVms();
  const res = await sendJson('PATCH', `/api/v1/browsers/${publicId}/config`, apiKey, { proxy: null });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: 'Only a running browser can be configured.',
    browser_id: publicId,
    status: 'suspended'
  });
  assert.deepEqual(proxies, []);
});

test('PATCH /:id/config answers 502, and keeps the old setting, when the VM fails', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  fakeProxyVms({ setProxy: async () => Promise.reject(new Error('guest agent did not answer')) });
  const path = `/api/v1/browsers/${publicId}/config`;
  const res = await sendJson('PATCH', path, apiKey, { proxy: 'http://proxy.example.com:8080' });
  assert.equal(res.status, 502);
  const read = await setupApp().request(path, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.deepEqual(await read.json(), { browser_id: publicId, proxy: null });
});

test('PATCH /:id/config answers 403 to a User who did not create the browser', async () => {
  const owner = await makeUser('owner@example.com');
  const { userId } = await makeUser();
  await createWorkspace({ name: 'Acme', ownerId: owner.userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme'
  });
  const apiKey = await makeKey({ workspaceId: 3333, userId });
  const publicId = await makeBrowser({ workspaceId: 3333, userId: owner.userId });
  const proxies = fakeProxyVms();
  const res = await sendJson('PATCH', `/api/v1/browsers/${publicId}/config`, apiKey, { proxy: null });
  assert.equal(res.status, 403);
  assert.deepEqual(proxies, []);
});

test('POST /api/v1/browsers with a proxy launches the VM with it, and records it masked', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const launches = [];
  fakeVms({
    canLaunchBrowser: async () => true,
    launchBrowser: async (options) => {
      launches.push(options);
      throw new Error('no VM in tests');
    }
  });
  const res = await sendJson('POST', '/api/v1/browsers', apiKey, { proxy: 'http://u:p@proxy.example.com:8080' });
  assert.equal(res.status, 200);
  const { browser_id: publicId } = await res.json();
  for (let i = 0; i < 100 && launches.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(launches, [
    { proxy: 'http://u:p@proxy.example.com:8080', screenResolution: null, screenScale: null }
  ]);
  const stored = await getBrowserInstanceByPublicId({ workspaceId, publicId });
  assert.deepEqual(stored.data.config, { proxy: 'http://u:****@proxy.example.com:8080' });
});

test('POST /api/v1/browsers with a bad proxy launches nothing', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  fakeVms({ canLaunchBrowser: async () => true });
  const res = await sendJson('POST', '/api/v1/browsers', apiKey, { proxy: 'ftp://proxy.example.com' });
  assert.equal(res.status, 400);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
});
