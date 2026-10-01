import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie, readSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./switch.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
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

// Seeds the signed-in user and its personal workspace, returning the
// generated workspace id, since switching back into it is exactly what
// several tests need to do.
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

const rewrittenSession = (res) => {
  const setCookie = res.headers.get('set-cookie');
  return setCookie ? readSessionCookie(decodeURIComponent(setCookie.match(/^session=([^;]*)/)[1])) : null;
};

test('POST /workspaces/switch redirects unauthenticated visitors to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/workspaces/switch', { method: 'POST' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('POST /workspaces/switch rejects a missing or invalid CSRF token, and switches nothing', async () => {
  await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/switch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: 2345, csrf: 'bogus' }).toString()
  });
  assert.equal(res.status, 403);
  assert.equal(rewrittenSession(res), null, 'the session cookie must be untouched');
});

test('POST /workspaces/switch switches into a workspace the caller belongs to', async () => {
  await makeUser();
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: 2002 });
  await createCollaborator({
    workspaceId: 2002,
    userId,
    email: 'user@example.com',
    role: 'Admin',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/switch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: 2002, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(rewrittenSession(res).activeWorkspaceId, 2002);
});

test('POST /workspaces/switch switches back into the personal workspace with no collaborator lookup', async () => {
  const personalWorkspaceId = await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/switch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: personalWorkspaceId, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(rewrittenSession(res).activeWorkspaceId, personalWorkspaceId);
});

test('POST /workspaces/switch refuses a workspace the caller does not belong to, and touches no cookie', async () => {
  await makeUser();
  // A real workspace exists, but no collaborator row for this user - an
  // honest 403, not a stubbed 404.
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: 2002 });

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/switch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: 2002, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /not a collaborator/i);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('POST /workspaces/switch refuses a malformed workspace id with no collaborator check, and switches nothing', async () => {
  await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces/switch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ workspace: '../../etc/passwd', csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 400);
  assert.equal(rewrittenSession(res), null, 'the session cookie must be untouched');
});
