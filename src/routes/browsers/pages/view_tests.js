import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

process.env.PGLITE_DATA_DIR = 'memory://';

const FAKE_PNG = Buffer.from('not a real png, just something to round-trip', 'utf8');
// Stub-recognised id with no page match, exercising the no-such-page path.
const NO_SUCH_PAGE_BROWSER_ID = 'no-such-page-browser';
// Stub id answering with a CDP-level error, unlike NO_SUCH_PAGE.
const CDP_ERROR_BROWSER_ID = 'cdp-error-browser';
// Default recognised id for the happy-path screenshot tests.
const DEFAULT_BROWSER_ID = 'default-browser';

// CDP stub starts before config freezes env at import.
const cdpStub = await new Promise((resolve) => {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
  wss.on('connection', (socket, req) => {
    const hasMatchingPage = !req.url.includes(`/${NO_SUCH_PAGE_BROWSER_ID}/`);
    const shouldError = req.url.includes(`/${CDP_ERROR_BROWSER_ID}/`);
    socket.on('message', (raw) => {
      const { id, method, sessionId } = JSON.parse(raw.toString());
      if (method === 'Target.getTargets') {
        if (shouldError) {
          socket.send(JSON.stringify({ id, error: { message: 'Inspected target navigated or closed' } }));
          return;
        }
        socket.send(
          JSON.stringify({
            id,
            result: { targetInfos: hasMatchingPage ? [{ targetId: 'page1', type: 'page' }] : [] }
          })
        );
      } else if (method === 'Target.attachToTarget') {
        socket.send(JSON.stringify({ id, result: { sessionId: 'session1' } }));
      } else if (method === 'Page.captureScreenshot') {
        socket.send(JSON.stringify({ id, sessionId, result: { data: FAKE_PNG.toString('base64') } }));
      }
    });
  });
  wss.once('listening', () => resolve(wss));
});
process.env.BROWSERFLEET_URL = `http://127.0.0.1:${cdpStub.address().port}`;
after(() => new Promise((resolve) => cdpStub.close(resolve)));

const { createSessionCookie } = await import('../../../auth/session.js');
const { routes } = await import('./view.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser, updateBrowserInstanceStatus, getBrowserInstanceByPublicId } =
  await import('../../../models/browsers.js');
const { closeDatabase } = await import('../../../db/database.js');

test.afterEach(async () => closeDatabase());

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

// Launches a browser, marks it provisioned with the given internal (CDP
// stub-recognised) id, and sets its status - the shape every test below needs.
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

test('GET /browsers/:browserId/pages/:pageId/view returns a PNG screenshot of that page', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: DEFAULT_BROWSER_ID,
    status: 'running'
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
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, FAKE_PNG);
});

test('GET /browsers/:browserId/pages/:pageId/view answers 404 when that page is no longer open', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: NO_SUCH_PAGE_BROWSER_ID,
    status: 'running'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 404);
});

// Successful capture proves reachability; it also feeds nextBrowserStatus.
test('GET /browsers/:browserId/pages/:pageId/view opportunistically marks a recovering browser running on a successful capture', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: DEFAULT_BROWSER_ID,
    status: 'error'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'running');
  assert.equal(status, 'running', 'the status write should have run');
});

// NO_SUCH_PAGE means live: it only comes after the websocket answered.
test('GET /browsers/:browserId/pages/:pageId/view still marks the browser running when the specific page is gone', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: NO_SUCH_PAGE_BROWSER_ID,
    status: 'error'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 404);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'running');
  assert.equal(status, 'running', 'the status write should have run despite the 404');
});

test('GET /browsers/:browserId/pages/:pageId/view writes nothing when an already-running browser stays connected', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: DEFAULT_BROWSER_ID,
    status: 'running'
  });

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

test('GET /browsers/:browserId/pages/:pageId/view opportunistically demotes a running browser to error when the CDP connection fails', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: CDP_ERROR_BROWSER_ID,
    status: 'running'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 502);
  const status = await settleStatus(workspaceId, browserPublicId, (s) => s === 'error');
  assert.equal(status, 'error', 'the status write should have run');
});

test('GET /browsers/:browserId/pages/:pageId/view opportunistically terminates a browser still unreachable after erroring', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, {
    internalBrowserId: CDP_ERROR_BROWSER_ID,
    status: 'error'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/pages/page1/view`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 502);
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
