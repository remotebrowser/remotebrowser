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
const { routes, PLAYGROUND_TEMPLATES } = await import('./show.js');
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
  // The status line polls its own endpoint, which knows the status shown and
  // brings the previews too. It asks at once, to swap in the live previews.
  assert.match(
    body,
    new RegExp(
      `<p[^>]*id="browser-status"[^>]*hx-get="/browsers/${browserPublicId}/status\\?shown=running"[^>]*hx-trigger="load, every 3s"`
    )
  );
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
  assert.match(body, /id="browser-connection-info"/);
  assert.match(body, /<script src="\/htmx\.min\.js"><\/script>/);
  // The <main> element itself carries no htmx attributes.
  assert.match(body, /<main>/);
  assert.doesNotMatch(body, /<main\s[^>]*hx-/);
  // The previews have no poll of their own; the status line's poll brings them.
  assert.match(body, /<div id="browser-preview" class="browser-preview">/);
  assert.doesNotMatch(body, /<div id="browser-preview"[^>]*hx-/);
  assert.doesNotMatch(body, /<canvas\s/);
  assert.match(
    body,
    /<script src="\/screencast\.js" defer><\/script>\s*<script src="\/playground\.js" defer><\/script>/
  );
  assert.match(body, new RegExp(`href="/browsers/${browserPublicId}/terminate"`), 'a running browser offers Terminate');
  // Inside the connection panel, so it appears when the status poll refreshes it.
  assert.match(body, /<div id="browser-connection-info">\s*<section id="playground-panel"/);
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
      '<section\\s+id="coding-panel"\\s+class="browser-panel instruction-block"\\s+data-copy-value="Use the reference code below[^"]*' +
        `${handle}[^"]*"\\s*>[\\s\\S]*?<div class="instruction-box">\\s*<p class="instruction-preamble">Use the reference code below[\\s\\S]*?</p>\\s*<pre id="instruction-block-playwright-js"><span class="visually-hidden">` +
        '```js\\s*</span><code>const \\{ chromium \\} = require\\(&#39;playwright&#39;\\);'
    )
  );
  // The instruction starts collapsed behind a toggle in the box's bottom left,
  // with Copy in the bottom right; both stay hidden until JS enables them.
  assert.match(
    body,
    /<div class="browser-panel-footer">\s*<button\s+type="button"\s+class="btn-secondary instruction-toggle hidden"\s+aria-expanded="false"\s+aria-controls="instruction-content"\s*>\s*<span class="instruction-toggle-label">Show instructions<\/span>\s*<\/button>\s*<button type="button" class="btn-primary code-copy-button hidden">Copy instructions<\/button>/
  );
  // Click handler in its own nonce'd partial; confirm it's in the page.
  assert.match(body, /<script nonce="test-nonce-value">[\s\S]*navigator\.clipboard\.writeText[\s\S]*<\/script>/);
  // The preview swap reuses the existing <img> nodes, so previews don't blank.
  assert.match(body, /htmx:beforeSwap[\s\S]*img\[id\^="screenshot-"\]/);
  // A status change refreshes the connection panel and the sidebar, so the
  // controls and the previews follow the status too.
  assert.match(body, /'browser-status-changed'[\s\S]*target: '#browser-connection-info'/);
  // The status line's own poll already brings the new controls and previews.
  assert.doesNotMatch(body, /target: '#browser-sidebar'/);
  assert.doesNotMatch(body, /setInterval/);
});

test('GET /browsers/:browserId renders the playground for a running browser', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId);
  const handle = (await getBrowserInstanceByPublicId({ workspaceId, publicId: browserPublicId })).data.browserHandle;

  const cookie = makeSessionCookie();
  const res = await setupApp().request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  const body = await res.text();
  // Hidden without JavaScript, which it needs to run; the script right after
  // <main> reveals it, and again after htmx settles a new one.
  assert.match(body, /<section id="playground-panel" class="browser-panel hidden" aria-label="Playground">/);
  assert.match(body, /<\/main>\s*<script nonce="test-nonce-value">\s*revealPlayground\(\);\s*<\/script>/);
  assert.match(body, /'htmx:afterSettle', revealPlayground/);
  // The worker dials the relay with the handle.
  assert.match(
    body,
    new RegExp(
      `<div\\s+id="playground"\\s+data-cdp-url="ws://localhost/cdp/${handle}"\\s+data-pages-url="/browsers/${browserPublicId}/pages"\\s*>`
    )
  );
  assert.match(body, /<textarea\s+id="playground-editor"/);
  // Hidden until a run takes longer than 2 seconds; playground.js fills it in.
  // The same button stops a run, so there is no separate Stop button.
  assert.match(
    body,
    /<\/select>\s*<span id="playground-elapsed" class="playground-elapsed hidden"><\/span>\s*<button type="button" id="playground-run" class="btn-primary" disabled>Run<\/button>/
  );
  assert.doesNotMatch(body, /id="playground-stop"/);
  // In the sidebar under the previews, hidden until a run ends.
  assert.match(
    body,
    /<div id="playground-output-block" class="hidden">\s*<div id="playground-output"[^>]*><\/div>\s*<p id="playground-status"[^>]*>[^<]*<\/p>\s*<\/div>/
  );
  const sidebar = body.slice(body.indexOf('id="browser-sidebar"'));
  assert.ok(sidebar.indexOf('id="browser-preview"') < sidebar.indexOf('id="playground-output-block"'));
  for (const template of PLAYGROUND_TEMPLATES) {
    assert.match(body, new RegExp(`<option value="${template.key}" data-code="[^"]*">${template.label}</option>`));
  }
  assert.match(body, /data-code="[^"]*page\.title\(\)/);
  // The playground leads, and the coding assistant follows.
  assert.ok(body.indexOf('id="playground-panel"') < body.indexOf('id="coding-panel"'));
});

// The sidebar opens with the status and the controls that act on it, side by
// side on a wide screen, with the screenshots below them.
test('GET /browsers/:browserId puts the status and the controls in the sidebar, above the previews', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: 'br-happy' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();

  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, `expected to find ${needle}`);
    return index;
  };
  // The sidebar is the grid's second column, after the details.
  const connectionInfo = at('id="browser-connection-info"');
  const sidebar = at('id="browser-sidebar"');
  assert.ok(connectionInfo < sidebar, 'the sidebar follows the details column');
  assert.doesNotMatch(body.slice(connectionInfo, sidebar), /\/terminate"/, 'the controls left the connection panel');
  // The status line and the controls share the status bar, and the previews
  // come after it.
  const bar = body.match(/<div class="browser-status-bar">([\s\S]*?)class="browser-preview"/);
  assert.ok(bar, 'the status bar sits above the previews');
  assert.match(bar[1], /id="browser-status"/);
  assert.match(bar[1], /class="browser-actions"/);
  assert.match(bar[1], new RegExp(`href="/browsers/${browserPublicId}/terminate"`));
  assert.ok(sidebar < at('class="browser-status-bar"'));
});

test('GET /browsers/:browserId streams each page preview for an htmx request', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: 'br-happy' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, {
    headers: { 'cookie': `session=${cookie}`, 'HX-Request': 'true' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('vary'), 'HX-Request');
  const body = await res.text();
  // One canvas per page, stacked in the same preview column.
  for (const pageId of ['page0', 'page1']) {
    assert.match(
      body,
      new RegExp(
        `<a class="page-preview-link" href="/browsers/${browserPublicId}/pages/${pageId}">\\s*<canvas\\s+class="browser-screenshot"\\s+id="screencast-${pageId}"[^>]*aria-label="Live view of Title for ${pageId} in calm-otter"[^>]*data-frame-url="/browsers/${browserPublicId}/pages/${pageId}/frame"`
      )
    );
  }
  assert.doesNotMatch(body, /<img\s+class="browser-screenshot"/);
  // No "load" here, or every swap would ask again at once.
  assert.match(body, /id="browser-status"[^>]*hx-trigger="every 3s"/);
});

test('GET /browsers/:browserId renders a preview for a browser with exactly one page', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: ONE_PAGE_BROWSER_ID });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(
    body,
    new RegExp(
      `<a class="page-preview-link" href="/browsers/${browserPublicId}/pages/page0">\\s*<img\\s+class="browser-screenshot"\\s+id="screenshot-page0"\\s+src="/browsers/${browserPublicId}/pages/page0/view\\?t=\\d+"`
    )
  );
  assert.doesNotMatch(body, /pages\/page1\/view/);
});

test('GET /browsers/:browserId omits previews when listing pages over CDP fails', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: CDP_ERROR_BROWSER_ID });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}`, { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /browser-screenshot/);
  // Right after it starts running, a browser may not answer yet, so the
  // starting box stays until there is a page to show.
  assert.match(
    body,
    /<div id="browser-preview" class="browser-preview">\s*<div class="browser-preview-placeholder browser-preview-starting"/
  );
  // Rest of page still renders; a CDP listing hiccup shouldn't break UI.
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
  // The unreachable notice lives inside the connection panel now.
  assert.match(body, /<div id="browser-connection-info">[\s\S]*temporarily unreachable[\s\S]*<\/div>/);
  assert.doesNotMatch(body, /browser-error-notice/);
  assert.doesNotMatch(body, /browser-starting-notice/);
  assert.doesNotMatch(body, /connectOverCDP/);
  assert.doesNotMatch(body, /browser-screenshot/);
  // Revert the preview so a stale handle can't keep polling a dead browser.
  assert.match(body, /<div id="browser-preview" class="browser-preview">\s*<\/div>/, 'the preview column stays, empty');
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
  // A terminated browser never changes again, so its status line stops polling.
  assert.match(body, /<p id="browser-status"><strong>Status:<\/strong> terminated<\/p>/);
  assert.match(body, /<div id="browser-preview" class="browser-preview">\s*<\/div>/, 'nor does its empty preview');
  // The stopped notice lives inside the connection panel now.
  assert.match(body, /<div id="browser-connection-info">[\s\S]*has been stopped[\s\S]*<\/div>/);
  assert.doesNotMatch(body, /browser-terminated-notice/);
  assert.doesNotMatch(body, /browser-error-notice/);
  assert.match(body, /<div id="browser-preview" class="browser-preview">\s*<\/div>/, 'the preview column stays, empty');
  assert.doesNotMatch(body, /\/terminate"/, 'a stopped browser offers no Terminate');
  assert.doesNotMatch(body, /id="playground-panel"/, 'a stopped browser offers no playground');
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
  // Like a suspended browser: a notice, then the panels to come, dimmed.
  assert.match(body, /<div id="browser-connection-info">[\s\S]*This browser is starting\./);
  assert.match(body, /<div class="browser-panels-disabled" inert>[\s\S]*id="playground-panel"[\s\S]*Copy instructions/);
  assert.doesNotMatch(body, /id="playground"/, 'the playground cannot run yet');
  assert.match(body, /<textarea\s+id="playground-editor"[^>]*>\s*await page\.goto/);
  assert.match(body, /data-cdp-url=""/);
  assert.doesNotMatch(body, /\/cdp\//);
  assert.doesNotMatch(body, /browser-starting-notice/);
  assert.doesNotMatch(body, /connectOverCDP/);
  assert.doesNotMatch(body, /browser-screenshot/, 'no screenshot until the browser is actually running');
  // Placeholder holds right column width so layout doesn't jump later.
  assert.match(body, /<main>/);
  assert.match(
    body,
    /<div id="browser-preview" class="browser-preview">\s*<div class="browser-preview-placeholder browser-preview-starting"/
  );
  assert.doesNotMatch(body, /id="browser-actions"[^>]*>\s*<a/, 'no controls while starting');
});

test('GET /browsers/:browserId/status brings the live previews out of band', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: 'br-happy' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/status?shown=running`, {
    headers: { 'cookie': `session=${cookie}`, 'HX-Request': 'true' }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  // The status line keeps asking for the previews, without "load" this time.
  assert.match(
    body,
    new RegExp(
      `^\\s*<p\\s+id="browser-status"[^>]*hx-get="/browsers/${browserPublicId}/status\\?shown=running"[^>]*hx-trigger="every 3s"`
    )
  );
  // The status line swaps the previews in out of band, by id.
  assert.match(body, /hx-select-oob="#browser-preview, #browser-actions"/);
  assert.match(body, /<div id="browser-preview" class="browser-preview">/);
  for (const pageId of ['page0', 'page1']) {
    assert.match(body, new RegExp(`<canvas\\s+class="browser-screenshot"\\s+id="screencast-${pageId}"`));
  }
  // The controls come only with a status change, so a poll leaves them alone.
  assert.doesNotMatch(body, /id="browser-actions"/);
  // A fragment, without the rest of the browser page.
  assert.doesNotMatch(body, /<html|connectOverCDP/);
});

test('GET /browsers/:browserId/status keeps the previews empty while the browser is not running', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { status: 'suspended' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/status?shown=suspended`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  // Nothing live, and no saved pictures here: a paused box keeps the column's shape.
  assert.match(
    await res.text(),
    /<div id="browser-preview" class="browser-preview">\s*<div class="browser-preview-placeholder browser-preview-paused">\s*<span class="browser-suspended-label">Suspended<\/span>/
  );
});

test('GET /browsers/:browserId/status announces a status change', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId);

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/status?shown=starting`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('hx-trigger'), 'browser-status-changed');
  const body = await res.text();
  assert.match(body, /hx-get="[^"]*\?shown=running"/);
  // The controls for the new status come along, out of band.
  assert.match(body, /<div id="browser-actions" class="browser-actions">/);
  assert.match(body, new RegExp(`href="/browsers/${browserPublicId}/terminate"`));
});

test('GET /browsers/:browserId/status stops polling once the browser is terminated', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { status: 'terminated' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/status?shown=running`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('hx-trigger'), 'browser-status-changed');
  const body = await res.text();
  assert.match(body, /<p id="browser-status"><strong>Status:<\/strong> terminated<\/p>/);
  assert.doesNotMatch(body, /hx-get/);
});

test('GET /browsers/:browserId/status returns 404 when the browser does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/999998/status', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/status keeps the previews empty once the browser is terminated', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { status: 'terminated' });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${browserPublicId}/status?shown=terminated`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<p id="browser-status"><strong>Status:<\/strong> terminated<\/p>/);
  assert.match(body, /<div id="browser-preview" class="browser-preview">\s*<\/div>/);
  assert.doesNotMatch(body, /hx-get/);
});
