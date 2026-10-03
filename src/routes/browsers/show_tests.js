import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

// Tokens verify only because requireUser skips RS256; config is dummy.
process.env.PGLITE_DATA_DIR = 'memory://';

// Stub-recognised ids for exercising the page-count line's edge cases.
const ONE_PAGE_BROWSER_ID = 'one-page-browser';
const CDP_ERROR_BROWSER_ID = 'cdp-error-browser';

// CDP stub starts before config freezes env at import. This is the real,
// unrelated BrowserFleet CDP endpoint - kept exactly as-is.
const cdpStub = await new Promise((resolve) => {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
  wss.on('connection', (socket, req) => {
    const shouldError = req.url.includes(`/${CDP_ERROR_BROWSER_ID}/`);
    const pageCount = req.url.includes(`/${ONE_PAGE_BROWSER_ID}/`) ? 1 : 2;
    socket.on('message', (raw) => {
      const { id, method } = JSON.parse(raw.toString());
      if (method !== 'Target.getTargets') {
        return;
      }
      if (shouldError) {
        socket.send(JSON.stringify({ id, error: { message: 'Inspected target navigated or closed' } }));
        return;
      }
      socket.send(
        JSON.stringify({
          id,
          result: {
            targetInfos: [
              ...Array.from({ length: pageCount }, (_, i) => ({
                targetId: `page${i}`,
                type: 'page',
                title: `Title for page${i}`,
                url: `https://example.com/page${i}`,
                attached: false
              })),
              { targetId: 'worker1', type: 'service_worker' }
            ]
          }
        })
      );
    });
  });
  wss.once('listening', () => resolve(wss));
});
process.env.BROWSERFLEET_URL = `http://127.0.0.1:${cdpStub.address().port}`;
after(() => new Promise((resolve) => cdpStub.close(resolve)));

const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./show.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser, updateBrowserInstanceStatus, getBrowserInstanceByPublicId } =
  await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

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

const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

// Seeds the signed-in user and its personal workspace, and returns the
// generated workspace id.
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

const makeSharedWorkspace = async ({ workspaceId, role = 'User' } = {}) => {
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId });
  await createCollaborator({
    workspaceId,
    userId,
    email: 'user@example.com',
    role,
    workspaceName: 'Acme Corp'
  });
};

// Seeds a browser in the given status, with a handle/internal id recorded
// (except when 'starting', which mirrors a browser that never finished provisioning).
const makeBrowser = async (
  workspaceId,
  { browserName = 'calm-otter', status = 'running', internalBrowserId = 'br-happy' } = {}
) => {
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName,
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  if (status !== 'starting') {
    await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId, userId });
    await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: status });
  }
  return launched.data.publicId;
};

test('GET /browsers/:browserId redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/999999');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test("GET /browsers/:browserId renders the status in the visitor's own workspace", async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: 'br-happy' });
  const handle = (await getBrowserInstanceByPublicId({ workspaceId, publicId: browserPublicId })).data.browserHandle;

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /calm-otter/);
  assert.match(body, /id="browser-status"[^>]*>\s*<strong>Status:<\/strong>\s*running/);
  // Per-page <img> to its own view route, wrapped in a link, ?t= not fixed.
  assert.match(
    body,
    new RegExp(
      `<a class="page-preview-link" href="/browsers/${browserPublicId}/pages/page0">\\s*<img\\s+class="browser-screenshot"\\s+id="screenshot-page0"\\s+src="/browsers/${browserPublicId}/pages/page0/view\\?t=\\d+"\\s+alt="Live view of Title for page0 in calm-otter"`
    )
  );
  assert.match(
    body,
    new RegExp(
      `<a class="page-preview-link" href="/browsers/${browserPublicId}/pages/page1">\\s*<img\\s+class="browser-screenshot"\\s+id="screenshot-page1"\\s+src="/browsers/${browserPublicId}/pages/page1/view\\?t=\\d+"\\s+alt="Live view of Title for page1 in calm-otter"`
    )
  );
  assert.doesNotMatch(body, /worker1/);
  assert.match(body, /class="breadcrumbs"/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Personal workspace</);
  assert.match(body, /href="\/browsers">Browsers/);
  assert.match(body, /aria-current="page">calm-otter/);
  // Shortened into the right column above the preview stack.
  assert.match(
    body,
    new RegExp(`id="browser-page-count">\\s*<a href="/browsers/${browserPublicId}/pages"\\s*>2 pages</a\\s*>`)
  );
  assert.match(body, /id="browser-connection-info"/);
  assert.match(body, /<script src="\/htmx\.min\.js"><\/script>/);
  // One <main> poll covers status, connection info, and screenshots.
  assert.doesNotMatch(body, /setInterval/);
  assert.match(
    body,
    new RegExp(
      `<main\\s+hx-get="/browsers/${browserPublicId}"\\s+hx-trigger="every 3s"\\s+hx-select="main"\\s+hx-swap="outerHTML"\\s*>`
    )
  );
  assert.match(body, /<div class="browser-preview">/);
  assert.doesNotMatch(body, /Browser handle/);
  assert.doesNotMatch(body, /hljs/);
  // The whole CDP URL is masked on screen; the real one only reaches the
  // data-copy-value attribute that the Copy button reads.
  assert.match(body, /connectOverCDP\(\*+\)/);
  assert.doesNotMatch(body, new RegExp(`<code>[\\s\\S]*/cdp/${handle}`));
  // The code sample gets its own Copy button, hidden until JS enables it.
  // The instruction is a prose preamble and a <pre> inside one box so the two
  // share a single seamless panel. The full source the Copy button reads lives
  // on the wrapper. The fences around the sample are visually hidden but stay
  // in the DOM, so the sample still copies as a fenced block.
  assert.match(
    body,
    new RegExp(
      '<div class="instruction-block" data-copy-value="Use the reference code below[^"]*' +
        `${handle}[^"]*">\\s*<button type="button" class="btn-primary code-copy-button hidden">Copy instructions</button>\\s*<div class="instruction-box">\\s*<p class="instruction-preamble">Use the reference code below[\\s\\S]*?</p>\\s*<pre id="instruction-block-playwright-js"><span class="visually-hidden">` +
        '```js\\s*</span><code>const \\{ chromium \\} = require\\(&#39;playwright&#39;\\);'
    )
  );
  // Click handler in its own nonce'd partial; confirm it's in the page.
  assert.match(body, /<script nonce="test-nonce-value">[\s\S]*navigator\.clipboard\.writeText[\s\S]*<\/script>/);
});

test('GET /browsers/:browserId omits the page count for a browser with exactly one page', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: ONE_PAGE_BROWSER_ID });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  // Single page not worth a "1 page" line; thumbnail is enough.
  assert.doesNotMatch(body, /browser-page-count/);
  assert.match(
    body,
    new RegExp(
      `<a class="page-preview-link" href="/browsers/${browserPublicId}/pages/page0">\\s*<img\\s+class="browser-screenshot"\\s+id="screenshot-page0"\\s+src="/browsers/${browserPublicId}/pages/page0/view\\?t=\\d+"`
    )
  );
  assert.doesNotMatch(body, /pages\/page1\/view/);
});

test('GET /browsers/:browserId omits the page count and previews when listing pages over CDP fails', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: CDP_ERROR_BROWSER_ID });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /browser-page-count/);
  assert.doesNotMatch(body, /browser-screenshot/);
  // Placeholder gates on !isConnectable, not on pages being null.
  assert.doesNotMatch(body, /class="browser-preview/);
  // Rest of page still renders; CDP page-count hiccup shouldn't break UI.
  assert.match(body, /id="browser-connection-info"/);
});

// Handle presence isn't enough (never cleared); status gates connection info.
test('GET /browsers/:browserId shows a distinct notice and reverts the preview when the browser has errored', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { status: 'error' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /id="browser-status"[^>]*>\s*<strong>Status:<\/strong>\s*error/);
  assert.doesNotMatch(body, /browser-connection-info/);
  assert.doesNotMatch(body, /browser-starting-notice/);
  assert.match(body, /id="browser-error-notice">[^<]+/);
  assert.doesNotMatch(body, /connectOverCDP/);
  assert.doesNotMatch(body, /browser-screenshot/);
  assert.doesNotMatch(body, /browser-page-count/);
  // Revert the preview so a stale handle can't keep polling a dead browser.
  assert.match(
    body,
    /<div class="browser-preview">\s*<div class="browser-preview-placeholder" aria-hidden="true"><\/div>\s*<\/div>/
  );
});

test('GET /browsers/:browserId shows a distinct notice when the browser has been terminated', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { status: 'terminated' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /id="browser-status"[^>]*>\s*<strong>Status:<\/strong>\s*terminated/);
  assert.doesNotMatch(body, /browser-connection-info/);
  assert.doesNotMatch(body, /browser-error-notice/);
  assert.match(body, /id="browser-terminated-notice">[^<]+/);
  assert.match(
    body,
    /<div class="browser-preview">\s*<div class="browser-preview-placeholder" aria-hidden="true"><\/div>\s*<\/div>/
  );
});

// Deleting a personal workspace while the user's pointer still named it, then
// watching the page self-heal, cannot be set up anymore: the FK from
// users.personal_workspace_id to workspaces forbids deleting a workspace a
// user still points at. The repair codepath itself (src/models/browsers.js's
// ensureWorkspaceForRepair) is still covered directly in
// src/models/browsers_tests.js.

test('GET /browsers/:browserId returns 404 when the browser does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/999998', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId redirects to / and clears a stale active workspace', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 2222 });
  const res = await app.request('/browsers/999998', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('GET /browsers/:browserId renders for the active shared workspace with unprefixed breadcrumbs', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333 });
  const browserPublicId = await makeBrowser(3333, { status: 'starting' });

  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 3333 });
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /id="browser-status"[^>]*>\s*<strong>Status:<\/strong>\s*starting/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /<a href="\/browsers">Browsers<\/a>/);
  assert.match(body, /aria-current="page">calm-otter/);
  assert.match(body, /id="browser-starting-notice">Connection details will appear here once the browser is ready\./);
  // Everything waits on the same <main> poll, not a separate interval.
  assert.doesNotMatch(body, /setInterval/);
  assert.doesNotMatch(body, /connectOverCDP/);
  assert.doesNotMatch(body, /browser-screenshot/, 'no screenshot until the browser is actually running');
  // Placeholder holds right column width so layout doesn't jump later.
  assert.match(
    body,
    new RegExp(
      `<main\\s+hx-get="/browsers/${browserPublicId}"\\s+hx-trigger="every 3s"\\s+hx-select="main"\\s+hx-swap="outerHTML"\\s*>`
    )
  );
  assert.match(
    body,
    /<div class="browser-preview">\s*<div class="browser-preview-placeholder" aria-hidden="true"><\/div>\s*<\/div>/
  );
});
