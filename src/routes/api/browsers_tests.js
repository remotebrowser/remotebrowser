import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Set before anything pulls in ../../config, which freezes what it read.
process.env.BROWSERFLEET_URL = 'http://browserfleet.test';
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
  getBrowserInstanceByPublicId
} = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

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
  internalBrowserId = 'foobar',
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

// The external fleet is the only HTTP call left; everything else hits the in-memory database.
const stubFleet = (respond) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    return respond(String(url), opts);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
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
  // Held back, so the launch answers before the fleet does, as in production.
  const fleet = stubFleet(() => new Promise(() => {}));
  try {
    const res = await call(setupApp(), '/api/v1/browsers', { method: 'POST', apiKey });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'launched');
    assert.match(body.browser_id, /^B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
    const stored = await getBrowserInstanceByPublicId({ workspaceId, publicId: body.browser_id });
    assert.equal(stored.data.creatorUserId, userId);
    assert.equal(stored.data.status, 'starting');
    assert.ok(fleet.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/browsers')));
  } finally {
    fleet.restore();
  }
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
  const fleet = stubFleet(() => new Response(JSON.stringify({ status: 'terminated' }), { status: 200 }));
  try {
    const res = await call(setupApp(), `/api/v1/browsers/${publicId}`, { method: 'DELETE', apiKey });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { browser_id: publicId, status: 'terminated' });
    assert.deepEqual(
      fleet.calls.map((c) => [c.method, c.url]),
      [['DELETE', 'http://browserfleet.test/api/v1/browsers/foobar']]
    );
    assert.deepEqual(await getBrowserInstanceByPublicId({ workspaceId, publicId }), { data: null });
  } finally {
    fleet.restore();
  }
});

test('DELETE /api/v1/browsers/:id answers 502 and keeps the browser when the fleet fails', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const fleet = stubFleet(() => new Response('', { status: 500 }));
  try {
    const res = await call(setupApp(), `/api/v1/browsers/${publicId}`, { method: 'DELETE', apiKey });
    assert.equal(res.status, 502);
    assert.ok((await getBrowserInstanceByPublicId({ workspaceId, publicId })).data);
  } finally {
    fleet.restore();
  }
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

// An external fleet has no suspend call, so the API says so rather than pretend.
test('POST /suspend and /resume answer 501 with an external fleet', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  for (const action of ['suspend', 'resume']) {
    const res = await call(setupApp(), `/api/v1/browsers/${publicId}/${action}`, { method: 'POST', apiKey });
    assert.equal(res.status, 501, action);
  }
});

test('GET /:id/config reports no proxy, and setting one answers 501, with an external fleet', async () => {
  const { userId, workspaceId } = await makeUser();
  const apiKey = await makeKey({ workspaceId, userId });
  const publicId = await makeBrowser({ workspaceId, userId });
  const app = setupApp();
  const config = await call(app, `/api/v1/browsers/${publicId}/config`, { apiKey });
  assert.deepEqual(await config.json(), { browser_id: publicId, proxy: null });

  const body = JSON.stringify({ proxy: 'http://proxy.example.com:8080' });
  const headers = { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const patched = await app.request(`/api/v1/browsers/${publicId}/config`, { method: 'PATCH', headers, body });
  assert.equal(patched.status, 501);
  const launched = await app.request('/api/v1/browsers', { method: 'POST', headers, body });
  assert.equal(launched.status, 501);
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
  const res = await call(setupApp(), '/api/v1/browsers', { method: 'POST', apiKey });
  assert.equal(res.status, 429);
  assert.match(res.headers.get('retry-after'), /^\d+$/);
  assert.match((await res.json()).error, /^This workspace launched too many browsers in the last minute\./);
});
