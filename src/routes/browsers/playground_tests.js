import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

// Tokens verify only because requireUser skips RS256; config is dummy.
process.env.PGLITE_DATA_DIR = 'memory://';

const CDP_ERROR_BROWSER_ID = 'cdp-error-browser';

// The CDP stub starts before config freezes env at import.
const cdpStub = await new Promise((resolve) => {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
  wss.on('connection', (socket, req) => {
    const shouldError = req.url.includes(`/${CDP_ERROR_BROWSER_ID}/`);
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
              ...Array.from({ length: 2 }, (_, i) => ({
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
const { routes, PLAYGROUND_TEMPLATES } = await import('./playground.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser, updateBrowserInstanceStatus, getBrowserInstanceByPublicId } =
  await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

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

const request = (path, over) => setupApp().request(path, { headers: { cookie: `session=${makeSessionCookie(over)}` } });

test('GET /browsers/:browserId/playground redirects an unauthenticated visitor to /signin', async () => {
  const res = await setupApp().request('/browsers/999999/playground');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/:browserId/playground renders the editor and live view for a running browser', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId);
  const handle = (await getBrowserInstanceByPublicId({ workspaceId, publicId: browserPublicId })).data.browserHandle;

  const res = await request(`/browsers/${browserPublicId}/playground`);
  assert.equal(res.status, 200);
  const body = await res.text();
  // The worker dials the relay with the handle; nothing else carries it.
  assert.match(
    body,
    new RegExp(
      `<article id="playground" class="browser-layout" data-cdp-url="ws://localhost/cdp/${handle}" data-pages-url="/browsers/${browserPublicId}/pages">`
    )
  );
  assert.match(body, /<textarea\s+id="playground-editor"/);
  assert.match(body, /<button type="button" id="playground-run" class="btn-primary" disabled>Run<\/button>/);
  // Hidden until a run takes longer than 2 seconds; playground.js fills it in.
  assert.match(
    body,
    /<\/select>\s*<span id="playground-elapsed" class="playground-elapsed hidden"><\/span>\s*<button type="button" id="playground-run"/
  );
  // The same button stops a run, so there is no separate Stop button.
  assert.doesNotMatch(body, /id="playground-stop"/);
  // Each run replaces the output, so it needs no Clear button.
  assert.doesNotMatch(body, /id="playground-clear"/);
  // The live view starts on the first page target, not the service worker.
  assert.match(body, new RegExp(`data-frame-url="/browsers/${browserPublicId}/pages/page0/frame"`));
  // Clicking it opens that page's own view, like the previews on the browser page.
  assert.match(
    body,
    new RegExp(
      `<a class="page-preview-link" href="/browsers/${browserPublicId}/pages/page0">\\s*<canvas\\s+class="browser-screenshot"`
    )
  );
  assert.match(body, /<script src="\/screencast\.js"><\/script>\s*<script src="\/playground\.js"><\/script>/);
  // Same page width as the other pages, with the live view as the usual sidebar,
  // under the status line and its controls, as on the browser page.
  assert.match(body, /<body class="">/);
  assert.match(
    body,
    /<div class="playground-sidebar">\s*<div class="browser-status-bar">[\s\S]*?<\/div>\s*<section class="playground-live browser-preview" aria-label="Live view and output">\s*<div id="page-live-view">\s*<a class="page-preview-link"/
  );
  // The status line polls without the previews: the playground has its own live view.
  assert.match(
    body,
    new RegExp(
      `id="browser-status"[^>]*hx-get="/browsers/${browserPublicId}/status\\?shown=running"[^>]*hx-trigger="every 3s"`
    )
  );
  assert.match(body, new RegExp(`href="/browsers/${browserPublicId}/terminate"`));
  assert.match(body, /<script src="\/htmx\.min\.js"><\/script>/);
  // A status change reloads, so the editor opens or closes with the browser.
  assert.match(body, /'browser-status-changed', \(\) => window\.location\.reload\(\)/);
  // The output sits under the live view, in the same column, hidden until a run ends.
  // No heading: the status line under the box says how the run ended.
  assert.match(
    body,
    /<\/canvas>\s*<\/a>\s*<\/div>\s*<div id="playground-output-block" class="hidden">\s*<div id="playground-output"[^>]*><\/div>\s*<p id="playground-status"[^>]*>[^<]*<\/p>\s*<\/div>\s*<\/section>\s*<\/div>\s*<\/article>/
  );
  assert.doesNotMatch(body, /<h2>Output<\/h2>/);
  assert.match(body, /aria-current="page">Playground/);
  assert.match(body, new RegExp(`<a href="/browsers/${browserPublicId}">calm-otter</a>`));
});

test('GET /browsers/:browserId/playground escapes template code into option attributes', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId);

  const body = await (await request(`/browsers/${browserPublicId}/playground`)).text();
  for (const template of PLAYGROUND_TEMPLATES) {
    assert.match(body, new RegExp(`<option value="${template.key}" data-code="[^"]*">${template.label}</option>`));
  }
  assert.match(body, /data-code="await page\.goto\(&#39;https:\/\/example\.com&#39;\);/);
});

test('GET /browsers/:browserId/playground leaves the live view empty when listing pages fails', async () => {
  const workspaceId = await makeUser();
  const browserPublicId = await makeBrowser(workspaceId, { internalBrowserId: CDP_ERROR_BROWSER_ID });

  const body = await (await request(`/browsers/${browserPublicId}/playground`)).text();
  assert.match(body, /id="playground-editor"/);
  assert.match(body, /data-frame-url=""/);
  // No known page yet, so the live view falls back to the browser's page list.
  assert.match(body, new RegExp(`<a class="page-preview-link" href="/browsers/${browserPublicId}/pages">\\s*<canvas`));
});

for (const status of ['starting', 'error', 'terminated']) {
  test(`GET /browsers/:browserId/playground hides the editor and CDP URL while the browser is ${status}`, async () => {
    const workspaceId = await makeUser();
    const browserPublicId = await makeBrowser(workspaceId, { status });

    const res = await request(`/browsers/${browserPublicId}/playground`);
    assert.equal(res.status, 200);
    const body = await res.text();
    // The status line says why; it polls (until terminated), so the playground
    // opens by itself once the browser runs.
    assert.match(body, new RegExp(`<strong>Status:</strong>\\s*${status}`));
    assert.match(body, /id="playground-not-ready"/);
    assert.doesNotMatch(body, /data-cdp-url/);
    assert.doesNotMatch(body, /\/cdp\//);
    assert.doesNotMatch(body, /playground\.js/);
  });
}

test('GET /browsers/:browserId/playground returns 404 when the browser does not exist', async () => {
  await makeUser();
  const res = await request('/browsers/999998/playground');
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/playground returns 404 for a browser in another workspace', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 4444 });
  const browserPublicId = await makeBrowser(4444);

  // The personal workspace is active, so the shared one's browser is not visible.
  const res = await request(`/browsers/${browserPublicId}/playground`);
  assert.equal(res.status, 404);
});
