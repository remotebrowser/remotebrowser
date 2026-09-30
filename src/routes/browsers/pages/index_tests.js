import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

process.env.PGLITE_DATA_DIR = 'memory://';

// A stub-recognised id with no open page, to exercise the empty-list state.
const NO_PAGE_BROWSER_ID = 'no-page-browser';

// A second recognised id, for the one page whose title/url are deliberately
// past the caption's truncation and domain-only thresholds.
const LONG_TITLE_BROWSER_ID = 'long-title-browser';

// A default recognised id used for the happy-path listing tests.
const DEFAULT_BROWSER_ID = 'default-browser';

// CDP stub starts before config freezes env; it returns getTargets' titles.
const cdpStub = await new Promise((resolve) => {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
  wss.on('connection', (socket, req) => {
    const hasPage = !req.url.includes(`/${NO_PAGE_BROWSER_ID}/`);
    const hasLongTitle = req.url.includes(`/${LONG_TITLE_BROWSER_ID}/`);
    socket.on('message', (raw) => {
      const { id, method } = JSON.parse(raw.toString());
      if (method !== 'Target.getTargets') {
        return;
      }
      socket.send(
        JSON.stringify({
          id,
          result: {
            targetInfos: hasLongTitle
              ? [
                  {
                    targetId: 'page1',
                    type: 'page',
                    title: 'This Title Is Much Longer Than Sixteen Characters',
                    url: 'https://sub.example.com/some/deep/path?query=1',
                    attached: false
                  }
                ]
              : hasPage
                ? [
                    {
                      targetId: 'page1',
                      type: 'page',
                      title: 'Title for page1',
                      url: 'https://example.com/page1',
                      attached: false
                    },
                    {
                      targetId: 'page2',
                      type: 'page',
                      title: 'Title for page2',
                      url: 'https://example.com/page2',
                      attached: false
                    },
                    { targetId: 'worker1', type: 'service_worker' }
                  ]
                : []
          }
        })
      );
    });
  });
  wss.once('listening', () => resolve(wss));
});
process.env.BROWSERFLEET_URL = `http://127.0.0.1:${cdpStub.address().port}`;
after(() => new Promise((resolve) => cdpStub.close(resolve)));

const { createSessionCookie } = await import('../../../auth/session.js');
const { routes } = await import('./index.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser } = await import('../../../models/browsers.js');
const { closeDatabase } = await import('../../../db/database.js');

test.afterEach(async () => closeDatabase());

// Stands in for what secureHeaders sets before the route runs in production.
const TEST_SCRIPT_NONCE = 'test-nonce-value';

const setupApp = () => {
  const app = new Hono();
  app.use((c, next) => {
    c.set('secureHeadersNonce', TEST_SCRIPT_NONCE);
    return next();
  });
  app.route('/browsers', routes);
  return app;
};

let userId;
let userPublicId;

const sessionCookie = (activeWorkspaceId) =>
  `session=${createSessionCookie({
    publicId: userPublicId,
    email: 'user@example.com',
    issuedAt: Date.now(),
    ...(activeWorkspaceId ? { activeWorkspaceId } : {})
  })}`;

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

// Launches a browser and marks it provisioned with the given internal (CDP
// stub-recognised) id, so getBrowserInstance sees a ready, running browser.
const makeReadyBrowser = async (workspaceId, internalBrowserId, browserName = 'calm-otter') => {
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName,
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId, userId });
  return launched.data.publicId;
};

test('GET /browsers/:browserId/pages redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/999999/pages');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/:browserId/pages returns 404 when the browser does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const res = await app.request('/browsers/999998/pages', { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/pages lists every open page, each linking to its own view', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeReadyBrowser(workspaceId, DEFAULT_BROWSER_ID);

  const app = setupApp();
  const res = await app.request(`/browsers/${browserPublicId}/pages`, { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /aria-current="page">Pages/);
  assert.match(body, new RegExp(`<a href="/browsers/${browserPublicId}">calm-otter</a>`));
  // One <img> per open page at its own view route, ?t= cache-buster not fixed.
  assert.match(
    body,
    new RegExp(
      `<img\\s+class="browser-screenshot"\\s+id="screenshot-page1"\\s+src="/browsers/${browserPublicId}/pages/page1/view\\?t=\\d+"\\s+alt="Title for page1"`
    )
  );
  assert.match(
    body,
    new RegExp(
      `<img\\s+class="browser-screenshot"\\s+id="screenshot-page2"\\s+src="/browsers/${browserPublicId}/pages/page2/view\\?t=\\d+"\\s+alt="Title for page2"`
    )
  );
  assert.match(body, new RegExp(`<a href="/browsers/${browserPublicId}/pages/page1">Title for page1</a>`));
  assert.match(body, new RegExp(`<a href="/browsers/${browserPublicId}/pages/page2">Title for page2</a>`));
  // The caption shows the domain only - no protocol, no path.
  assert.match(body, /class="page-card-url">example\.com</);
  assert.doesNotMatch(body, /class="page-card-url">https:\/\/example\.com\/page1</);
  assert.doesNotMatch(body, /worker1/);
  // Swaps all of <main> since the empty/not-ready states have no .pages-grid.
  assert.match(body, /<script src="\/htmx\.min\.js"><\/script>/);
  assert.match(
    body,
    new RegExp(
      `<script nonce="${TEST_SCRIPT_NONCE}">[\\s\\S]*setInterval[\\s\\S]*target: 'main', select: 'main', swap: 'outerHTML'`
    )
  );
});

test('GET /browsers/:browserId/pages truncates a long title and shows only the URL domain', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeReadyBrowser(workspaceId, LONG_TITLE_BROWSER_ID);

  const app = setupApp();
  const res = await app.request(`/browsers/${browserPublicId}/pages`, { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  // First 15 characters plus a trailing ellipsis - 16 characters total.
  assert.match(body, new RegExp(`<a href="/browsers/${browserPublicId}/pages/page1">This Title Is M…</a>`));
  assert.doesNotMatch(body, /This Title Is Much Longer/);
  assert.match(body, /class="page-card-url">sub\.example\.com</);
  assert.doesNotMatch(body, /class="page-card-url">https:\/\/sub\.example\.com/);
});

test('GET /browsers/:browserId/pages shows an empty-list message for a browser with no open pages', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeReadyBrowser(workspaceId, NO_PAGE_BROWSER_ID);

  const app = setupApp();
  const res = await app.request(`/browsers/${browserPublicId}/pages`, { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /id="browser-pages-empty">No pages are currently open\./);
  // Poll unconditional; pages appear without reloading.
  assert.match(body, new RegExp(`<script nonce="${TEST_SCRIPT_NONCE}">[\\s\\S]*setInterval`));
});

test('GET /browsers/:browserId/pages shows a not-ready message while the browser is still starting', async () => {
  const workspaceId = await makeUser();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  // Left 'starting': recordProvisionedBrowser never ran, so internalBrowserId is empty.

  const app = setupApp();
  const res = await app.request(`/browsers/${launched.data.publicId}/pages`, {
    headers: { cookie: sessionCookie() }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /id="browser-pages-unavailable">Pages will appear here once the browser is ready\./);
  // Unconditional poll; recovers into grid once CDP is reachable.
  assert.match(body, new RegExp(`<script nonce="${TEST_SCRIPT_NONCE}">[\\s\\S]*setInterval`));
});

test('GET /browsers/:browserId/pages redirects to / and clears a stale active workspace', async () => {
  await makeUser();
  const app = setupApp();
  const res = await app.request('/browsers/999999/pages', { headers: { cookie: sessionCookie(3333) } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});
