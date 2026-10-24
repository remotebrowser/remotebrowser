import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../auth/session.js');
const { routes } = await import('./homepage.js');
const { findOrCreateUser } = await import('../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../models/workspaces.js');
const { launchBrowserInstance, updateBrowserInstanceStatus } = await import('../models/browsers.js');
const { createApiKey } = await import('../models/apikeys.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/', routes);
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

// Seeds the signed-in user and its personal workspace, and returns the
// generated workspace id (requireUser would otherwise build it lazily on the
// first request, but several tests need the id upfront).
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

test('GET / redirects an anonymous visitor to /signin', async () => {
  const res = await setupApp().request('/');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET / builds a workspace for an account that has none yet, then renders it', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const res = await setupApp().request('/', { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /No browsers yet\./);
});

test("GET / renders the visitor's own workspace, with no roster to manage", async () => {
  await makeUser();
  const res = await setupApp().request('/', { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, />user@example\.com</);
  assert.match(body, /href="\/browsers\/launch"/);
  assert.doesNotMatch(body, /Workspace Management/);
  assert.doesNotMatch(body, /href="\/workspace"/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Personal workspace</);
  assert.match(body, /class="breadcrumb-switcher-item">New workspace</);
  assert.match(body, /No browsers yet\./);
  assert.doesNotMatch(body, /Show all browsers/, 'nothing to show all of, when there are no browsers at all');
});

// A stale active workspace heals to / without looping (via the user pointer).
test('GET / heals a stale active workspace rather than 404ing', async () => {
  await makeUser();
  const res = await setupApp().request('/', { headers: { cookie: sessionCookie(3333) } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

// Re-renders the page server-side each tick, so tabs see fresh status.
test('GET / polls itself every few seconds to pick up a status change', async () => {
  await makeUser();
  const res = await setupApp().request('/', { headers: { cookie: sessionCookie() } });
  const body = await res.text();
  assert.match(body, /<script src="\/htmx\.min\.js"><\/script>/);
  assert.match(body, /<main hx-get="\/" hx-trigger="every 3s" hx-select="main" hx-swap="outerHTML">/);
});

// Deleting a personal workspace while the Users pointer still named it, then
// watching the dashboard self-heal, cannot be set up anymore: the FK from
// users.personal_workspace_id to workspaces forbids deleting a workspace a
// user still points at, and forbids pointing at one that does not exist. The
// repair codepath itself (src/models/browsers.js's ensureWorkspaceForRepair)
// is still covered directly in src/models/browsers_tests.js.

test('GET / renders a dashboard scoped to the active shared workspace, with unprefixed links and its browsers table', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 2222 });
  const launched = await launchBrowserInstance({
    workspaceId: 2222,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });

  const res = await setupApp().request('/', { headers: { cookie: sessionCookie(2222) } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Acme Corp/);
  assert.match(body, new RegExp(`<a href="/browsers/${launched.data.publicId}">calm-otter</a>`));
  assert.match(body, /href="\/browsers">Show all browsers/);
  assert.match(body, /href="\/workspace"/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /class="breadcrumb-switcher-active">▸ Acme Corp</);
  assert.match(body, /class="breadcrumb-switcher-item">Personal workspace</);
});

// Dashboard shows live browsers; 'Show all browsers' reaches the rest.
test('GET / shows only starting or running browsers in its table', async () => {
  const workspaceId = await makeUser();
  const launchAs = (browserName) => launchBrowserInstance({ workspaceId, userId, browserName, browserDescription: '' });
  const setStatus = (browserInstanceId, toStatus) =>
    updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus });

  const running = await launchAs('calm-otter');
  await setStatus(running.data.browserInstanceId, 'running');

  await launchAs('brave-fox'); // left 'starting'

  const errored = await launchAs('quiet-owl');
  await setStatus(errored.data.browserInstanceId, 'error');

  const terminated = await launchAs('gone-lynx');
  await setStatus(terminated.data.browserInstanceId, 'terminated');

  const res = await setupApp().request('/', { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /calm-otter/, 'running belongs on the dashboard');
  assert.match(body, /brave-fox/, 'starting belongs on the dashboard');
  assert.doesNotMatch(body, /quiet-owl/, 'error does not belong on the dashboard');
  assert.doesNotMatch(body, /gone-lynx/, 'terminated does not belong on the dashboard');
  assert.match(body, /href="\/browsers">Show all browsers/, 'the full list still has all four');
});

// Zero active browsers differs from zero total; still show the "all" link.
test('GET / still offers "Show all browsers" when every browser has been filtered out of the table', async () => {
  const workspaceId = await makeUser();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'quiet-owl',
    browserDescription: ''
  });
  await updateBrowserInstanceStatus({
    workspaceId,
    browserInstanceId: launched.data.browserInstanceId,
    toStatus: 'terminated'
  });

  const res = await setupApp().request('/', { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /No browsers yet\./);
  assert.match(body, /href="\/browsers">Show all browsers/);
});

test('GET / says there are no API keys, and offers to generate one', async () => {
  await makeUser();
  const body = await (await setupApp().request('/', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<h2>API Keys<\/h2>\s*<div class="api-key-summary">\s*<p>You have no API keys\.<\/p>/);
  assert.match(
    body,
    /You have no API keys\.<\/p>\s*<a href="\/api-keys\/generate" class="btn-secondary">New API key<\/a>/
  );
  assert.doesNotMatch(body, /<a href="\/api-keys">/);
});

test("GET / counts the caller's valid API keys in the active workspace, and links to them", async () => {
  const workspaceId = await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333 });
  const live = await createApiKey({ workspaceId, userId, name: 'ci-runner', expiration: '30d' });
  await createApiKey({ workspaceId, userId, name: 'nightly', expiration: '1d' });
  await createApiKey({
    workspaceId,
    userId,
    name: 'old-laptop',
    expiration: '1h',
    now: Date.now() - 2 * 60 * 60 * 1000
  });
  await createApiKey({ workspaceId: 3333, userId, name: 'acme-only', expiration: '1d' });

  const body = await (await setupApp().request('/', { headers: { cookie: sessionCookie() } })).text();
  // Two: the expired key and the one in another workspace do not count.
  assert.match(
    body,
    /<p>You have <a href="\/api-keys">2 API keys<\/a>\.<\/p>\s*<a href="\/api-keys\/generate" class="btn-secondary">New API key<\/a>/
  );
  // A count only: no list, and never the key.
  assert.doesNotMatch(body, /ci-runner|api-keys-table|Show all API keys/);
  assert.ok(!body.includes(live.data.apiKey));
});

test('GET / says "1 API key" for a single key', async () => {
  const workspaceId = await makeUser();
  await createApiKey({ workspaceId, userId, name: 'only', expiration: '1d' });
  const body = await (await setupApp().request('/', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<p>You have <a href="\/api-keys">1 API key<\/a>\.<\/p>/);
});

// Otherwise an Admin with no keys of their own would have no way to the list of
// everyone's keys, to revoke one.
test('GET / offers Manage API keys to an Admin of a shared workspace with no keys of their own', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333, role: 'Admin' });
  const body = await (await setupApp().request('/', { headers: { cookie: sessionCookie(3333) } })).text();
  assert.match(
    body,
    /You have no API keys\.<\/p>\s*<a href="\/api-keys\/generate" class="btn-secondary">New API key<\/a>\s*<a href="\/api-keys" class="btn-secondary">Manage API keys<\/a>/
  );
});

test('GET / leaves out Manage API keys for a User, for an Admin with keys, and in a personal workspace', async () => {
  await makeUser();
  // Personal workspace: no other members.
  let body = await (await setupApp().request('/', { headers: { cookie: sessionCookie() } })).text();
  assert.doesNotMatch(body, /Manage API keys/);

  await makeSharedWorkspace({ workspaceId: 3333, role: 'User' });
  body = await (await setupApp().request('/', { headers: { cookie: sessionCookie(3333) } })).text();
  assert.doesNotMatch(body, /Manage API keys/);

  await makeSharedWorkspace({ workspaceId: 4444, role: 'Admin' });
  await createApiKey({ workspaceId: 4444, userId, name: 'mine', expiration: '1d' });
  body = await (await setupApp().request('/', { headers: { cookie: sessionCookie(4444) } })).text();
  assert.doesNotMatch(body, /Manage API keys/, 'the count already links there');
  assert.match(body, /<a href="\/api-keys">1 API key<\/a>/);
});

test('GET / hides New API key once a personal workspace has 10 keys, and offers it below that', async () => {
  const workspaceId = await makeUser();
  for (let i = 0; i < 9; i += 1) {
    await createApiKey({ workspaceId, userId, name: `key-${i}`, expiration: '1d' });
  }
  let body = await (await setupApp().request('/', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /class="btn-secondary">New API key<\/a>/);
  assert.doesNotMatch(body, /api-key-limit-note/);

  await createApiKey({ workspaceId, userId, name: 'key-9', expiration: '1d' });
  body = await (await setupApp().request('/', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<a href="\/api-keys">10 API keys<\/a>/);
  assert.doesNotMatch(body, /New API key/);
  assert.match(body, /<span class="api-key-limit-note">You've reached the limit\.<\/span>/);
});

test('GET / hides New API key once a member has 5 keys in a shared workspace', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333 });
  for (let i = 0; i < 5; i += 1) {
    await createApiKey({ workspaceId: 3333, userId, name: `key-${i}`, expiration: '1d' });
  }
  const body = await (await setupApp().request('/', { headers: { cookie: sessionCookie(3333) } })).text();
  assert.match(body, /<a href="\/api-keys">5 API keys<\/a>/);
  assert.doesNotMatch(body, /New API key/);
  assert.match(body, /You've reached the limit\./);
});
