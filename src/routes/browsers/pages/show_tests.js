import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Tokens verify only because requireUser skips RS256; config is dummy.
process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../../auth/session.js');
const { routes } = await import('./show.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser } = await import('../../../models/browsers.js');
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

test('GET /browsers/:browserId/pages/:pageId redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/999999/pages/page1');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/:browserId/pages/:pageId returns 404 when the browser does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/999998/pages/page1', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 404);
});

test('GET /browsers/:browserId/pages/:pageId renders the live view for a ready browser', async () => {
  const workspaceId = await makeUser();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'br-happy',
    userId
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${launched.data.publicId}/pages/page1`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /aria-current="page">page1/);
  assert.match(body, new RegExp(`<a href="/browsers/${launched.data.publicId}/pages">Pages</a>`));
  assert.match(
    body,
    new RegExp(
      `<img class="page-screenshot" src="/browsers/${launched.data.publicId}/pages/page1/view" alt="Live view of this page"`
    )
  );
});

test('GET /browsers/:browserId/pages/:pageId shows a not-ready message while the browser is still starting', async () => {
  const workspaceId = await makeUser();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  // Left 'starting': recordProvisionedBrowser never ran, so internalBrowserId is empty.

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request(`/browsers/${launched.data.publicId}/pages/page1`, {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /page-screenshot/);
  assert.match(
    body,
    /id="browser-page-starting-notice">This page's live view will appear here once the browser is ready\./
  );
});

test('GET /browsers/:browserId/pages/:pageId redirects to / and clears a stale active workspace', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 3333 });
  const res = await app.request('/browsers/999999/pages/page1', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});
