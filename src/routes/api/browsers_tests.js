import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Set before anything pulls in ../../config, which freezes what it read.
process.env.PGLITE_DATA_DIR = 'memory://';

const { routes } = await import('./browsers.js');
const { createApiKey } = await import('../../models/apikeys.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const {
  MAX_BROWSER_LAUNCHES_PER_MINUTE,
  launchBrowserInstance,
  recordProvisionedBrowser,
  updateBrowserInstanceStatus,
  getBrowserInstanceByPublicId,
  listBrowserInstancesByWorkspace
} = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');
const { setVmClient, createVmClient } = await import('../../vm/index.js');

test.afterEach(async () => {
  setVmClient(createVmClient());
  await closeDatabase();
});

const setupApp = () => {
  const app = new Hono();
  app.route('/api/v1/browsers', routes);
  return app;
};

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, workspaceId: workspace.data.workspaceId };
};

const makeKey = async ({ workspaceId, userId }) =>
  (await createApiKey({ workspaceId, userId, name: 'test', expiration: '1d' })).data.apiKey;

const call = (app, path, { apiKey, method = 'GET' } = {}) =>
  app.request(path, { method, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });

const makeBrowser = async ({
  workspaceId,
  userId,
  status = 'running',
  internalBrowserId = 'Qabc12345',
  description = ''
}) => {
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: description
  });
  const { browserInstanceId, publicId } = launched.data;
  await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId, userId });
  await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: status });
  return publicId;
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
    canLaunchBrowser: record('canLaunchBrowser', true),
    launchableOses: record('launchableOses', ['debian-13', 'ubuntu-26.04']),
    launchBrowser: record('launchBrowser', { browserId: 'Qabc12345' }),
    browserExists: record('browserExists', true),
    stopBrowser: record('stopBrowser', undefined),
    suspendBrowser: record('suspendBrowser', undefined),
    resumeBrowser: record('resumeBrowser', { browserId: 'Qabc12345' }),
    browserIsRunning: record('browserIsRunning', true),
    resolveCdpUrl: record('resolveCdpUrl', null),
    ...overrides
  });
  return calls;
};

test('every endpoint answers 401 with a Bearer challenge without an API key', async () => {
  const app = setupApp();
  for (const [method, path] of [
    ['POST', '/api/v1/browsers'],
    ['GET', '/api/v1/browsers'],
    ['GET', '/api/v1/browsers/Bxxxxxx'],
    ['DELETE', '/api/v1/browsers/Bxxxxxx'],
    ['GET', '/api/v1/browsers/Bxxxxxx/cdp']
  ]) {
    for (const apiKey of [undefined, 'sk-rb-v1-nope']) {
      const res = await call(app, path, { method, apiKey });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    }
  }
});

test('POST /api/v1/browsers launches a browser in the key’s workspace', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  // Held back, so the launch answers before the VM is up, as in production.
  const launches = [];
  fakeVms({
    launchBrowser: (options) => {
      launches.push(options);
      return new Promise(() => {});
    }
  });
  const res = await call(setupApp(), '/api/v1/browsers', { method: 'POST', apiKey });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'launched');
  assert.match(body.browser_id, /^B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  const stored = await getBrowserInstanceByPublicId({ workspaceId, publicId: body.browser_id });
  assert.equal(stored.data.creatorUserId, userId);
  assert.equal(stored.data.status, 'starting');
  assert.equal(launches.length, 1);
});

test('GET /api/v1/browsers lists only the starting and running browsers of the key’s workspace', async () => {
  const { userId, workspaceId } = await makeUser();
  const other = await makeUser('other@example.com');
  const apiKey = await makeKey({ workspaceId, userId });
  const running = await makeBrowser({ workspaceId, userId });
  const starting = (await launchBrowserInstance({ workspaceId, userId, browserName: 'new' })).data.publicId;
  await makeBrowser({ workspaceId, userId, status: 'suspended', internalBrowserId: 'sleepy' });
  await makeBrowser({ workspaceId: other.workspaceId, userId: other.userId, internalBrowserId: 'theirs' });

  const res = await call(setupApp(), '/api/v1/browsers', { apiKey });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).sort(), [running, starting].sort());
});

test('GET /api/v1/browsers/:id returns the browser’s id, status, and description', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId, description: 'For QA testing' });
  const res = await call(setupApp(), `/api/v1/browsers/${publicId}`, { apiKey });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { browser_id: publicId, status: 'running', description: 'For QA testing' });

  // No description, e.g. one launched through the API, is an empty string.
  const suspended = await makeBrowser({ workspaceId, userId, status: 'suspended', internalBrowserId: 'sleepy' });
  const res2 = await call(setupApp(), `/api/v1/browsers/${suspended}`, { apiKey });
  assert.deepEqual(await res2.json(), { browser_id: suspended, status: 'suspended', description: '' });
});

test('GET and DELETE answer 404 for a browser in another workspace, or none at all', async () => {
  const { userId, workspaceId } = await makeUser();
  const other = await makeUser('other@example.com');
  const apiKey = await makeKey({ workspaceId, userId });
  const theirs = await makeBrowser({ workspaceId: other.workspaceId, userId: other.userId });
  const app = setupApp();
  for (const id of [theirs, 'Bzzzzzz']) {
    for (const method of ['GET', 'DELETE']) {
      const res = await call(app, `/api/v1/browsers/${id}`, { method, apiKey });
      assert.equal(res.status, 404, `${method} ${id}`);
      assert.deepEqual(await res.json(), { error: 'Browser not found.' });
    }
  }
  assert.ok(await getBrowserInstanceByPublicId({ workspaceId: other.workspaceId, publicId: theirs }));
});

test('DELETE /api/v1/browsers/:id terminates the browser', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const stopped = [];
  fakeVms({ stopBrowser: async (browserId) => void stopped.push(browserId) });
  const res = await call(setupApp(), `/api/v1/browsers/${publicId}`, { method: 'DELETE', apiKey });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { browser_id: publicId, status: 'terminated' });
  assert.deepEqual(stopped, ['Qabc12345']);
  assert.deepEqual(await getBrowserInstanceByPublicId({ workspaceId, publicId }), { data: null });
});

test('DELETE /api/v1/browsers/:id answers 502 and keeps the browser when the VM fails to stop', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  fakeVms({ stopBrowser: async () => Promise.reject(new Error('unable to stop the VM')) });
  const res = await call(setupApp(), `/api/v1/browsers/${publicId}`, { method: 'DELETE', apiKey });
  assert.equal(res.status, 502);
  assert.ok((await getBrowserInstanceByPublicId({ workspaceId, publicId })).data);
});

// A key acts with its creator's rights, the same as the Terminate page.
test('DELETE /api/v1/browsers/:id answers 403 to a User who did not create the browser', async () => {
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
  const res = await call(setupApp(), `/api/v1/browsers/${publicId}`, { method: 'DELETE', apiKey });
  assert.equal(res.status, 403);
  assert.ok((await getBrowserInstanceByPublicId({ workspaceId: 3333, publicId })).data);
});

test('GET /api/v1/browsers/:id/cdp without a WebSocket upgrade answers 426', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const res = await call(setupApp(), '/api/v1/browsers/Bxxxxxx/cdp', { apiKey });
  assert.equal(res.status, 426);
});

test('POST /api/v1/browsers answers 429 with Retry-After once the workspace is over the launch rate', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  // Launches made a moment ago, as many as the rate allows.
  const { getDatabase } = await import('../../db/database.js');
  await (
    await getDatabase()
  ).query(
    'INSERT INTO browser_launches(workspace_id,user_id,launched_timestamp) SELECT $1,$2,$3 FROM generate_series(1,$4)',
    [workspaceId, userId, Date.now() - 1000, MAX_BROWSER_LAUNCHES_PER_MINUTE]
  );
  // Without this, a host with no VM snapshot (like CI) answers 503 first.
  const calls = fakeVms();
  const res = await call(setupApp(), '/api/v1/browsers', { method: 'POST', apiKey });
  assert.equal(res.status, 429);
  assert.match(res.headers.get('retry-after'), /^\d+$/);
  assert.match((await res.json()).error, /^This workspace launched too many browsers in the last minute\./);
  assert.ok(!calls.includes('launchBrowser'));
});

const statusOf = async (workspaceId, publicId) =>
  (await getBrowserInstanceByPublicId({ workspaceId, publicId })).data.status;

test('POST /suspend then /resume moves a browser from running to suspended and back', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const calls = fakeVms();

  const suspended = await call(setupApp(), `/api/v1/browsers/${publicId}/suspend`, { method: 'POST', apiKey });
  assert.equal(suspended.status, 200);
  assert.deepEqual(await suspended.json(), { browser_id: publicId, status: 'suspended' });
  assert.equal(await statusOf(workspaceId, publicId), 'suspended');

  const resumed = await call(setupApp(), `/api/v1/browsers/${publicId}/resume`, { method: 'POST', apiKey });
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

  const resume = await call(setupApp(), `/api/v1/browsers/${running}/resume`, { method: 'POST', apiKey });
  assert.equal(resume.status, 409);
  assert.deepEqual(await resume.json(), {
    error: 'Only a suspended browser can be resumed.',
    browser_id: running,
    status: 'running'
  });
  const suspend = await call(setupApp(), `/api/v1/browsers/${suspended}/suspend`, { method: 'POST', apiKey });
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
  const res = await call(setupApp(), `/api/v1/browsers/${publicId}/suspend`, { method: 'POST', apiKey });
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
    const res = await call(setupApp(), `/api/v1/browsers/${theirs}/${action}`, { method: 'POST', apiKey });
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
  const res = await call(setupApp(), `/api/v1/browsers/${publicId}/suspend`, { method: 'POST', apiKey });
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
    [{ os: 'ubuntu' }, 'Unknown setting: os.'],
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
    { os: 'debian-13', proxy: 'http://u:p@proxy.example.com:8080', screenResolution: null, screenScale: null }
  ]);
  const stored = await getBrowserInstanceByPublicId({ workspaceId, publicId });
  assert.deepEqual(stored.data.config, { proxy: 'http://u:****@proxy.example.com:8080' });
});

// Waits for the launches that the API starts after it answers.
const launchesOf = async (apiKey, os) => {
  const launches = [];
  fakeVms({
    launchBrowser: async (options) => {
      launches.push(options.os);
      throw new Error('no VM in tests');
    }
  });
  const res = await sendJson('POST', '/api/v1/browsers', apiKey, os === undefined ? {} : { os });
  assert.equal(res.status, 200, String(os));
  for (let i = 0; i < 100 && launches.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return launches;
};

test('POST /api/v1/browsers launches on Debian 13 by default, or the os it names, in any case', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  assert.deepEqual(await launchesOf(apiKey, undefined), ['debian-13']);
  for (const os of ['debian-13', 'Debian13', 'DEBIAN-13']) {
    assert.deepEqual(await launchesOf(apiKey, os), ['debian-13'], os);
  }
  for (const os of ['ubuntu-26.04', 'Ubuntu', 'ubuntu26.04', 'UBUNTU-26.04']) {
    assert.deepEqual(await launchesOf(apiKey, os), ['ubuntu-26.04'], os);
  }
});

test('POST /api/v1/browsers refuses an unknown os, and launches nothing', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const calls = fakeVms();
  for (const os of ['windows-11', 'debian', 'ubuntu-24.04', '', 13, null]) {
    const res = await sendJson('POST', '/api/v1/browsers', apiKey, { os });
    assert.equal(res.status, 400, String(os));
    assert.deepEqual(await res.json(), { error: 'The os must be one of debian-13, ubuntu-26.04.' });
  }
  assert.ok(!calls.includes('launchBrowser'));
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
});

test('POST /api/v1/browsers answers 503 for an os whose snapshot is not ready, and launches nothing', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const calls = fakeVms({ launchableOses: async () => ['debian-13'] });
  const res = await sendJson('POST', '/api/v1/browsers', apiKey, { os: 'ubuntu' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: 'Ubuntu 26.04 browsers are not available here yet. Please try again later.'
  });
  assert.ok(!calls.includes('launchBrowser'));
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
});

test('POST /api/v1/browsers with a bad proxy launches nothing', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  fakeVms({ canLaunchBrowser: async () => true });
  const res = await sendJson('POST', '/api/v1/browsers', apiKey, { proxy: 'ftp://proxy.example.com' });
  assert.equal(res.status, 400);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
});
