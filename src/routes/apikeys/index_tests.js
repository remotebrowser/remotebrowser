import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { routes, formatRelativeTime } = await import('./index.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const { createApiKey, recordApiKeyUse } = await import('../../models/apikeys.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/api-keys', routes);
  return app;
};

let userId;
let userPublicId;

const sessionCookie = () =>
  `session=${createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now() })}`;

const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const workspace = await ensurePersonalWorkspace({ userId, email: 'user@example.com', personalWorkspaceId: null });
  return workspace.data.workspaceId;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

test('formatRelativeTime says how far ahead or ago in the largest whole unit', () => {
  for (const [remaining, expected] of [
    [5000, 'in 1 minute'],
    [3 * MINUTE_MS, 'in 3 minutes'],
    // Rounded up into the next unit rather than "in 60 minutes" or "in 24 hours".
    [59.6 * MINUTE_MS, 'in 1 hour'],
    [5 * HOUR_MS, 'in 5 hours'],
    [23.6 * HOUR_MS, 'in 1 day'],
    // A key made a moment ago still reads as its full lifetime.
    [7 * DAY_MS - 5, 'in 7 days'],
    [90 * DAY_MS - 5, 'in 90 days'],
    [-5000, '1 minute ago'],
    [-3 * MINUTE_MS, '3 minutes ago'],
    [-5 * HOUR_MS, '5 hours ago'],
    [-2 * DAY_MS, '2 days ago']
  ]) {
    assert.equal(formatRelativeTime(remaining), expected, `for ${remaining} ms`);
  }
});

test('GET /api-keys redirects an anonymous visitor to /signin', async () => {
  const res = await setupApp().request('/api-keys');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /api-keys lists every valid API key of the caller, not only the 5 most recent', async () => {
  const workspaceId = await makeUser();
  for (let index = 1; index <= 7; index += 1) {
    await createApiKey({ workspaceId, userId, name: `key-${index}`, expiration: '7d' });
  }
  await createApiKey({ workspaceId, userId, name: 'expired', expiration: '1h', now: Date.now() - 2 * HOUR_MS });

  const res = await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /aria-current="page">API keys/);
  for (let index = 1; index <= 7; index += 1) {
    assert.match(body, new RegExp(`>key-${index}</a></td>`));
  }
  assert.doesNotMatch(body, />expired<\/a><\/td>/);
  assert.match(body, />in 7 days<\/time>/);
  assert.match(body, /<a href="\/api-keys\/generate" class="btn-primary">Generate a new API key<\/a>/);
});

test('GET /api-keys says so when there are no valid API keys', async () => {
  await makeUser();
  const body = await (await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<p>You have no API keys\.<\/p>/);
  assert.doesNotMatch(body, /api-keys-table/, 'no empty table');
});

test('GET /api-keys in a shared workspace lists every member’s keys, with their creator, for an Admin only', async () => {
  await makeUser();
  const bob = await findOrCreateUser({ email: 'bob@example.com' });
  await createWorkspace({ name: 'Acme', ownerId: userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'Admin',
    workspaceName: 'Acme'
  });
  await createCollaborator({
    workspaceId: 3333,
    userId: bob.data.id,
    email: 'bob@example.com',
    role: 'User',
    workspaceName: 'Acme'
  });
  await createApiKey({ workspaceId: 3333, userId, name: 'mine', expiration: '1d' });
  await createApiKey({ workspaceId: 3333, userId: bob.data.id, name: 'bobs', expiration: '1d' });
  const cookie = (publicId, email) =>
    `session=${createSessionCookie({ publicId, email, issuedAt: Date.now(), activeWorkspaceId: 3333 })}`;

  const asAdmin = await (
    await setupApp().request('/api-keys', { headers: { cookie: cookie(userPublicId, 'user@example.com') } })
  ).text();
  assert.match(asAdmin, /<th role="columnheader">Created by<\/th>/);
  assert.match(asAdmin, />bobs<\/a><\/td>/);
  assert.match(asAdmin, /<td role="cell" data-label="Created by">bob@example\.com<\/td>/);
  assert.match(asAdmin, />mine<\/a><\/td>/);

  const asBob = await (
    await setupApp().request('/api-keys', { headers: { cookie: cookie(bob.data.publicId, 'bob@example.com') } })
  ).text();
  assert.match(asBob, />bobs<\/a><\/td>/);
  assert.doesNotMatch(asBob, />mine<\/a><\/td>/);
  assert.doesNotMatch(asBob, /Created by/);
});

test('GET /api-keys in a personal workspace has no Created by column', async () => {
  const workspaceId = await makeUser();
  await createApiKey({ workspaceId, userId, name: 'mine', expiration: '1d' });
  const body = await (await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } })).text();
  assert.doesNotMatch(body, /Created by/);
});

test('GET /api-keys says when each key was last used, or Never, right after Expires', async () => {
  const workspaceId = await makeUser();
  await createApiKey({ workspaceId, userId, name: 'unused', expiration: '7d' });
  const used = await createApiKey({ workspaceId, userId, name: 'used', expiration: '7d' });
  await recordApiKeyUse({ apiKeyId: used.data.apiKeyId, now: Date.now() - 2 * DAY_MS });

  const body = await (await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<th role="columnheader">Expires<\/th>\s*<th role="columnheader">Last used<\/th>/);
  const row = (name) => body.slice(body.indexOf(`>${name}</a>`), body.indexOf('</tr>', body.indexOf(`>${name}</a>`)));
  assert.match(row('unused'), /<td role="cell" data-label="Last used">\s*Never\s*<\/td>/);
  assert.match(row('used'), /title="[^"]+"\s*>2 days ago<\/time>/);
});

test('GET /api-keys hides Generate once a personal workspace has 10 keys', async () => {
  const workspaceId = await makeUser();
  for (let i = 0; i < 10; i += 1) {
    await createApiKey({ workspaceId, userId, name: `key-${i}`, expiration: '1d' });
  }
  const body = await (await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, />key-9<\/a><\/td>/);
  assert.doesNotMatch(body, /Generate a new API key/);
  assert.match(body, /You've reached the limit of 10 API keys in this workspace\.\s*<\/span>/);
  assert.doesNotMatch(body, /Delete one/);
});

// An Admin's list holds everyone's keys, but only their own count toward their limit.
test('GET /api-keys counts only an Admin’s own keys toward their limit in a shared workspace', async () => {
  await makeUser();
  const bob = await findOrCreateUser({ email: 'bob@example.com' });
  await createWorkspace({ name: 'Acme', ownerId: userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'Admin',
    workspaceName: 'Acme'
  });
  await createCollaborator({
    workspaceId: 3333,
    userId: bob.data.id,
    email: 'bob@example.com',
    role: 'User',
    workspaceName: 'Acme'
  });
  for (let i = 0; i < 5; i += 1) {
    await createApiKey({ workspaceId: 3333, userId: bob.data.id, name: `bob-${i}`, expiration: '1d' });
  }
  const cookie = `session=${createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), activeWorkspaceId: 3333 })}`;
  let body = await (await setupApp().request('/api-keys', { headers: { cookie } })).text();
  assert.match(body, />bob-4<\/a><\/td>/);
  assert.match(body, /Generate a new API key/, 'five of Bob’s keys do not use up the Admin’s');

  for (let i = 0; i < 5; i += 1) {
    await createApiKey({ workspaceId: 3333, userId, name: `mine-${i}`, expiration: '1d' });
  }
  body = await (await setupApp().request('/api-keys', { headers: { cookie } })).text();
  assert.doesNotMatch(body, /Generate a new API key/);
  assert.match(body, /You've reached the limit of 5 API keys in this workspace\./);
});

test('GET /api-keys says how many keys the caller has, and any limit, above the list', async () => {
  const workspaceId = await makeUser();
  await createApiKey({ workspaceId, userId, name: 'only', expiration: '1d' });
  let body = await (await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<h1>API keys<\/h1>\s*<div class="api-key-summary">\s*<p>You have 1 API key\.<\/p>/);
  assert.doesNotMatch(body, /api-key-limit-note/);
  assert.ok(body.indexOf('You have 1 API key.') < body.indexOf('api-keys-table'), 'the count comes before the list');

  for (let i = 0; i < 9; i += 1) {
    await createApiKey({ workspaceId, userId, name: `key-${i}`, expiration: '1d' });
  }
  body = await (await setupApp().request('/api-keys', { headers: { cookie: sessionCookie() } })).text();
  assert.match(body, /<p>You have 10 API keys\.<\/p>\s*<span class="api-key-limit-note">\s*You've reached the limit/);
  assert.ok(
    body.indexOf("You've reached the limit") < body.indexOf('api-keys-table'),
    'the limit comes before the list'
  );
});
