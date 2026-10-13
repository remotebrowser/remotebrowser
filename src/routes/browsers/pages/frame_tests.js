import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';
process.env.BROWSERFLEET_URL = 'http://fleet.test';

const FAKE_JPEG = Buffer.from('not a real jpeg, just something to round-trip', 'utf8');
const BROWSER_ID = 'br-1';

const { createSessionCookie } = await import('../../../auth/session.js');
const { routes } = await import('./frame.js');
const { cache } = await import('../../../screencast.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser } = await import('../../../models/browsers.js');
const { closeDatabase } = await import('../../../db/database.js');

test.afterEach(async () => closeDatabase());

// Skips the CDP dial.
const seedScreencast = ({ pageId = 'page1', frame = { seq: 5, data: FAKE_JPEG, timestamp: Date.now() } } = {}) => {
  const entry = {
    key: `${BROWSER_ID}:${pageId}`,
    frame,
    waiters: new Set(),
    lastRead: Date.now(),
    closed: false,
    unacked: null,
    socket: null,
    sessionId: null,
    send: null,
    ready: Promise.resolve({ ok: true }),
    idleTimer: null
  };
  cache.screencasts.set(entry.key, entry);
  return entry;
};
test.beforeEach(() => {
  cache.screencasts = new Map();
});

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

// Launches a browser and marks it provisioned with the given internal id.
const makeBrowser = async (workspaceId, { internalBrowserId }) => {
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
  return launched.data.publicId;
};

test('GET /browsers/:browserId/pages/:pageId/frame redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/999999/pages/page1/frame');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/:browserId/pages/:pageId/frame returns 404 when the browser does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/999998/pages/page1/frame', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/pages/:pageId/frame answers 503 while the browser is still starting', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {});

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/frame`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 503);
});

test('GET /browsers/:browserId/pages/:pageId/frame returns the latest JPEG frame with its sequence number', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID });
  seedScreencast();

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/frame?after=4`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-frame-seq'), '5');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FAKE_JPEG);
});

test('GET /browsers/:browserId/pages/:pageId/frame holds the request until a newer frame arrives', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID });
  const entry = seedScreencast();

  const app = setupApp();
  const cookie = makeSessionCookie();
  const pending = app.request(`/browsers/${browserPublicId}/pages/page1/frame?after=5`, {
    headers: { cookie: `session=${cookie}` }
  });
  while (entry.waiters.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  entry.frame = { seq: 6, data: FAKE_JPEG, timestamp: Date.now() };
  for (const wake of [...entry.waiters]) {
    wake({ data: entry.frame });
  }
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-seq'), '6');
});

test('GET /browsers/:browserId/pages/:pageId/frame answers 404 when the page is gone', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID });
  const entry = seedScreencast();
  entry.ready = Promise.resolve({ error: 'NO_SUCH_PAGE' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/frame`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/pages/:pageId/frame answers 502 when the screencast cannot start', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID });
  const entry = seedScreencast();
  entry.ready = Promise.resolve({ error: 'CONNECT_TIMEOUT' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/frame`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 502);
});

test('GET frame resizes the JPEG to the w query parameter', async () => {
  const { default: sharp } = await import('sharp');
  const source = await sharp({
    create: { width: 800, height: 400, channels: 3, background: { r: 0x88, g: 0x88, b: 0x88 } }
  })
    .jpeg()
    .toBuffer();
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: BROWSER_ID });
  seedScreencast({ frame: { seq: 5, data: source, timestamp: Date.now() } });
  const app = setupApp();
  const cookie = `session=${makeSessionCookie()}`;
  const smaller = await app.request(`/browsers/${browserPublicId}/pages/page1/frame?w=200`, { headers: { cookie } });
  assert.equal(smaller.status, 200);
  const meta = await sharp(Buffer.from(await smaller.arrayBuffer())).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 100);
  // A frame is never enlarged.
  const larger = await app.request(`/browsers/${browserPublicId}/pages/page1/frame?w=1600`, { headers: { cookie } });
  assert.equal((await sharp(Buffer.from(await larger.arrayBuffer())).metadata()).width, 800);
});
