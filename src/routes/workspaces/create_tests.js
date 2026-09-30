import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { generateWorkspaceName, routes } = await import('./create.js');

test('generateWorkspaceName produces an "adjective-animals" name', () => {
  const name = generateWorkspaceName();
  assert.match(name, /^[a-z]+-[a-z]+$/);
});

test('generateWorkspaceName produces varied names across calls', () => {
  const names = new Set(Array.from({ length: 50 }, () => generateWorkspaceName()));
  assert.ok(names.size > 1);
});

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie, readSessionCookie } = await import('../../auth/session.js');
const { client } = await import('../../middleware/client.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { getCollaborator } = await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.use('*', client);
  app.route('/workspaces', routes);
  return app;
};

let userId;
let userPublicId;
const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });
// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

// Seeds the signed-in user; requireUser builds the personal workspace lazily
// on the first request, so tests don't need to know its id upfront.
const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
};

test('GET /workspaces/create redirects unauthenticated visitors to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/workspaces/create');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /workspaces/create renders the create-workspace form', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/create', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /action="\/workspaces\/create"/);
  assert.match(body, /name="name"/);
  assert.match(body, /<span aria-current="page">Create<\/span>/);
  assert.match(body, /name="name" value="[a-z]+-[a-z]+"/);
});

test('POST /workspaces/create keeps the submitted name when re-rendering an error', async () => {
  await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/create', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name: 'x'.repeat(81), csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), new RegExp(`value="${'x'.repeat(81)}"`));
});

test('POST /workspaces/create rejects a missing or invalid CSRF token', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/create', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `session=${cookie}` },
    body: new URLSearchParams({ name: 'Acme Corp', csrf: 'bogus' }).toString()
  });
  assert.equal(res.status, 403);
});

test('POST /workspaces/create rejects a missing name', async () => {
  await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/create', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name: '', csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /workspace name/i);
});

// Switch to the new workspace so the redirect lands on its roster.
test('POST /workspaces/create creates a Workspace and an Owner Collaborator, switches into it, and redirects to /workspace', async () => {
  await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/create', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name: 'Acme Corp', csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/workspace');

  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, "the new workspace must become the session's active workspace");
  const rewritten = decodeURIComponent(setCookie.match(/^session=([^;]*)/)[1]);
  const workspaceId = readSessionCookie(rewritten).activeWorkspaceId;
  assert.ok(Number.isSafeInteger(workspaceId));

  const seat = await getCollaborator({ workspaceId, userId });
  assert.equal(seat.data.role, 'Owner');
  assert.equal(seat.data.workspaceName, 'Acme Corp');
});
