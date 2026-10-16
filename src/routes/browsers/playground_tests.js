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
      `<article id="playground" class="playground" data-cdp-url="ws://localhost/cdp/${handle}" data-pages-url="/browsers/${browserPublicId}/pages">`
    )
  );
  assert.match(body, /<textarea\s+id="playground-editor"/);
  assert.match(body, /<button type="button" id="playground-run" class="btn-primary" disabled>Run<\/button>/);
  // The live view starts on the first page target, not the service worker.
  assert.match(body, new RegExp(`data-frame-url="/browsers/${browserPublicId}/pages/page0/frame"`));
  assert.match(body, /<script src="\/screencast\.js"><\/script>\s*<script src="\/playground\.js"><\/script>/);
  assert.match(body, /<body class="wide">/);
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
});

for (const status of ['starting', 'error', 'terminated']) {
  test(`GET /browsers/:browserId/playground hides the editor and CDP URL while the browser is ${status}`, async () => {
    const workspaceId = await makeUser();
    const browserPublicId = await makeBrowser(workspaceId, { status });

    const res = await request(`/browsers/${browserPublicId}/playground`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, new RegExp(`id="playground-not-ready"[\\s\\S]*<strong>${status}</strong>`));
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
