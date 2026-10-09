import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { config } = await import('../../config.js');
const { createSessionCookie, readSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./index.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { launchBrowserInstance, updateBrowserInstanceStatus, getBrowserInstance } =
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

test('GET /browsers redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test("GET /browsers renders the visitor's own workspace with no workspace chosen", async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, />user@example\.com</);
  assert.match(body, /class="browser-table-actions">\s*<a href="\/browsers\/launch"/);
  assert.match(body, /class="breadcrumbs"/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Personal workspace</);
  assert.match(body, /aria-current="page">Browsers/);
  assert.match(body, /No browsers yet\./);
});

// Deleting a personal workspace while the user's pointer still named it, then
// watching the page self-heal, cannot be set up anymore: the FK from
// users.personal_workspace_id to workspaces forbids deleting a workspace a
// user still points at. The repair codepath itself (src/models/browsers.js's
// ensureWorkspaceForRepair) is still covered directly in
// src/models/browsers_tests.js.

test("GET /browsers renders a table of the active workspace's browser instances, newest first", async () => {
  const workspaceId = await makeUser();
  const otter = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  await updateBrowserInstanceStatus({
    workspaceId,
    browserInstanceId: otter.data.browserInstanceId,
    toStatus: 'running'
  });
  const fox = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'brave-fox',
    browserDescription: ''
  });
  await updateBrowserInstanceStatus({
    workspaceId,
    browserInstanceId: fox.data.browserInstanceId,
    toStatus: 'running'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<th>Name<\/th>/);
  assert.match(body, /<th>Status<\/th>/);
  assert.match(body, new RegExp(`<a href="/browsers/${otter.data.publicId}">calm-otter</a>`));
  assert.match(body, new RegExp(`<a href="/browsers/${fox.data.publicId}">brave-fox</a>`));
  const foxIndex = body.indexOf('brave-fox');
  const otterIndex = body.indexOf('calm-otter');
  assert.ok(foxIndex > -1 && otterIndex > -1, 'both browser names render');
  assert.ok(foxIndex < otterIndex, 'the newer instance (brave-fox) renders before the older one');
});

test('GET /browsers shows a capacity notice and disables the launch link once at the limit', async () => {
  const workspaceId = await makeUser();
  for (let i = 0; i < config.maxPersonalBrowsers; i += 1) {
    await launchBrowserInstance({
      workspaceId,
      userId,
      browserName: `browser-${i}`,
      browserDescription: ''
    });
  }

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(`Using ${config.maxPersonalBrowsers} of ${config.maxPersonalBrowsers} browsers`));
  assert.match(body, /span class="btn-primary" aria-disabled="true">Launch a browser</);
  assert.doesNotMatch(body, /<a href="\/browsers\/launch"/);
});

// A page load only reads; nothing about a browser's status is written synchronously.
test('GET /browsers does not touch browser statuses on page load', async () => {
  const workspaceId = await makeUser();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  await updateBrowserInstanceStatus({
    workspaceId,
    browserInstanceId: launched.data.browserInstanceId,
    toStatus: 'running'
  });

  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const fetched = await getBrowserInstance({ workspaceId, browserInstanceId: launched.data.browserInstanceId });
  assert.equal(fetched.data.status, 'running', 'nothing should be written synchronously after the page load');
});

// Session names a workspace caller is no longer on; middleware heals it.
test('GET /browsers redirects to / and clears a stale active workspace', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 2222 });
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const rewritten = res.headers.get('set-cookie');
  assert.ok(rewritten, 'the stale choice must be cleared, not just bypassed once');
  const token = decodeURIComponent(rewritten.match(/^session=([^;]*)/)[1]);
  assert.equal(readSessionCookie(token).activeWorkspaceId, undefined);
});

// Re-renders the page server-side each tick, so tabs see fresh status.
test('GET /browsers polls itself every few seconds to pick up a status change', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  const body = await res.text();
  assert.match(body, /<script src="\/htmx\.min\.js"><\/script>/);
  assert.match(body, /<main hx-get="\/browsers" hx-trigger="every 3s" hx-select="main" hx-swap="outerHTML">/);
});

test('GET /browsers renders the active shared workspace with unprefixed links', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333 });
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 3333 });
  const res = await app.request('/browsers', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Acme Corp/);
  assert.match(body, /class="browser-table-actions">\s*<a href="\/browsers\/launch"/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /aria-current="page">Browsers/);
  assert.match(body, /No browsers yet\./);
});
