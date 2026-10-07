import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';
// refreshPage resolves the CDP URL through browserCdpUrl, which needs an http
// origin; the injected fake pool ignores the URL, so nothing is dialed.
process.env.BROWSERFLEET_URL = 'http://fleet.test';

const FAKE_PNG = Buffer.from('not a real png, just something to round-trip', 'utf8');
const BROWSER_ID = 'br-1';

const { createSessionCookie } = await import('../../../auth/session.js');
const { routes } = await import('./view.js');
const { cache } = await import('../../../screenshots.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser, updateBrowserInstanceStatus, getBrowserInstanceByPublicId } =
  await import('../../../models/browsers.js');
const { closeDatabase } = await import('../../../db/database.js');

test.afterEach(async () => closeDatabase());

// Each test starts with an empty cache and a fake pool whose capture result it
// picks, so no worker thread or CDP dial runs.
let captureResult;
const resetScreenshots = () => {
  captureResult = { data: FAKE_PNG };
  cache.screenshots = new Map();
  cache.inFlight = new Map();
  cache.pool = {
    capture: async () => captureResult,
    close: async () => {}
  };
};
test.beforeEach(resetScreenshots);

const isPng = (buffer) => buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG';

// Lets the fire-and-forget capture queued by a miss settle.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const setupApp = () => {
  const app = new Hono();
  app.route('/browsers', routes);
  return app;
};

let userId;
let userPublicId;

const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

// Seeds the signed-in user and its personal workspace, returning the id.
const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const workspace = await ensurePersonalWorkspace({
    userId,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  return workspace.data.workspaceId;
};

// Launches a browser, marks it provisioned with the given internal id, and sets
// its status - the shape every test below needs.
const makeBrowser = async (workspaceId, { internalBrowserId, status }) => {
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  if (internalBrowserId) {
    await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId, userId });
  }
  if (status) {
    await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: status });
  }
  return launched.data.publicId;
};

// Status update runs unawaited after the response; poll the real row for it.
const settleStatus = async (workspaceId, publicId, predicate) => {
  for (let i = 0; i < 100; i += 1) {
    const fetched = await getBrowserInstanceByPublicId({ workspaceId, publicId });
    if (predicate(fetched.data.status)) {
      return fetched.data.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return (await getBrowserInstanceByPublicId({ workspaceId, publicId })).data.status;
};

test('GET /browsers/:browserId/pages/:pageId/view redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/999999/pages/page1/view');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/:browserId/pages/:pageId/view returns 404 when the browser does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/999998/pages/page1/view', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/pages/:pageId/view answers 503 while the browser is still starting', async () => {
  const workspaceId = await makeUser();
  // No recordProvisionedBrowser call: internalBrowserId stays empty, status 'starting'.
  const browserPublicId = await makeBrowser(workspaceId, {});

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 503);
});

test('GET /browsers/:browserId/pages/:pageId/view returns the cached PNG of that page', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'running' });
  cache.screenshots.set(`${BROWSER_ID}:page1`, {
    browserId: BROWSER_ID,
    pageId: 'page1',
    data: FAKE_PNG,
    timestamp: Date.now()
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  assert.equal(res.headers.get('pragma'), 'no-cache');
  assert.equal(res.headers.get('expires'), '0');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FAKE_PNG);
});

test('GET /browsers/:browserId/pages/:pageId/view serves a transparent placeholder while the cache warms', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'running' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(isPng(body), 'the placeholder must be a PNG');
  assert.notDeepEqual(body, FAKE_PNG, 'a miss must not serve the page frame');
});

test('GET /browsers/:browserId/pages/:pageId/view queues a capture on a miss so the next request hits the cache', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'running' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const first = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.ok(isPng(Buffer.from(await first.arrayBuffer())));

  await flush();
  const second = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), FAKE_PNG);
});

// A successful capture proves reachability; it also feeds nextBrowserStatus.
test('GET /browsers/:browserId/pages/:pageId/view opportunistically marks a recovering browser running on a successful capture', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'error' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'running');
  assert.equal(status, 'running', 'the status write should have run');
});

// NO_SUCH_PAGE means live: it only comes after the CDP connection answered.
test('GET /browsers/:browserId/pages/:pageId/view still marks the browser running when the specific page is gone', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'error' });
  captureResult = { error: 'NO_SUCH_PAGE' };

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'running');
  assert.equal(status, 'running', 'the status write should have run despite the missing page');
});

test('GET /browsers/:browserId/pages/:pageId/view writes nothing when an already-running browser stays connected', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'running' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  // Settle first so a fire-and-forget write could appear before asserting none.
  await settleStatus(workspaceId, browserPublicId, () => false);
  const fetched = await getBrowserInstanceByPublicId({ workspaceId, publicId: browserPublicId });
  assert.equal(fetched.data.status, 'running');
});

test('GET /browsers/:browserId/pages/:pageId/view opportunistically demotes a running browser to error when the capture fails', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'running' });
  captureResult = { error: 'CDP_ERROR' };

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'error');
  assert.equal(status, 'error', 'the status write should have run');
});

test('GET /browsers/:browserId/pages/:pageId/view opportunistically terminates a browser still unreachable after erroring', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID, status: 'error' });
  captureResult = { error: 'CDP_ERROR' };

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'terminated');
  assert.equal(status, 'terminated', 'the status write should have run');
});

test('GET /browsers/:browserId/pages/:pageId/view redirects to / and clears a stale active workspace', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 3333 });
  const res = await app.request('/browsers/999999/pages/page1/view', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});
