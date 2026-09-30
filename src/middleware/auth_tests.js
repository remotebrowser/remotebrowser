import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { config } = await import('../config.js');
const { currentUser, requireUser, requireGuest } = await import('./auth.js');
const { createSessionCookie } = await import('../auth/session.js');
const { findOrCreateUser, revokeSessions, setPersonalWorkspaceId } = await import('../models/users.js');
const { createWorkspace } = await import('../models/workspaces.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

// No user row exists at this public id; used where the test wants an authenticated
// session that still fails to resolve to a real account.
const NO_SUCH_USER_PUBLIC_ID = 'zzzzzzzzz';

const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: NO_SUCH_USER_PUBLIC_ID, email: 'user@example.com', issuedAt: Date.now(), ...over });

// A real workspace row, so a real user can legitimately point at it (the FK
// forbids an arbitrary made-up id).
const makeWorkspace = (ownerId) => createWorkspace({ name: 'Team', ownerId, workspaceId: 2345 });

const makeUser = async ({ sessionExpirationTimestamp, personalWorkspaceId } = {}) => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const { id, publicId } = created.data;
  if (sessionExpirationTimestamp !== undefined) {
    await revokeSessions({ id, expirationTimestamp: sessionExpirationTimestamp });
  }
  if (personalWorkspaceId) {
    await makeWorkspace(id);
    await setPersonalWorkspaceId({ id, workspaceId: personalWorkspaceId });
  }
  return { id, publicId };
};

const resolvedUser = (id, publicId, over = {}) => ({
  id,
  publicId,
  email: 'user@example.com',
  personalWorkspaceId: null,
  activeWorkspaceId: null,
  ...over
});

const withAuth = (mw, handler) => {
  const app = new Hono();
  app.use('/x', mw);
  app.get('/x', handler);
  return app;
};

test('currentUser returns null when no session cookie is present', async () => {
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const res = await app.request('/who');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null });
});

test('currentUser returns null for an unsigned / tampered session cookie', async () => {
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const res = await app.request('/who', { headers: { cookie: 'session=tampered' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null });
  assert.equal(res.headers.get('set-cookie'), null);
});

test('currentUser returns the id and email for a valid, unexpired session', async () => {
  const { id: userId, publicId } = await makeUser({ personalWorkspaceId: 2345 });
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const res = await app.request('/who', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: resolvedUser(userId, publicId, { personalWorkspaceId: 2345 }) });
});

test('currentUser takes the canonical email from the user row over the cookie', async () => {
  const created = await findOrCreateUser({ email: 'row@example.com' });
  const { id: userId, publicId } = created.data;
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const cookie = makeSessionCookie({ publicId, email: 'stale@example.com' });
  const res = await app.request('/who', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: resolvedUser(userId, publicId, { email: 'row@example.com' }) });
});

test('requireUser redirects unauthenticated requests to /signin', async () => {
  const app = withAuth(requireUser, (c) => c.text('secret'));
  const res = await app.request('/x');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('requireUser exposes the user to downstream handlers and proceeds', async () => {
  const { id: userId, publicId } = await makeUser({ personalWorkspaceId: 2345 });
  let captured;
  const app = withAuth(requireUser, (c) => {
    captured = c.get('user');
    return c.json({ user: captured });
  });
  const res = await app.request('/x', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: resolvedUser(userId, publicId, { personalWorkspaceId: 2345 }) });
});

test('requireGuest redirects authenticated users to /', async () => {
  const { id: userId, publicId } = await makeUser();
  const app = withAuth(requireGuest, (c) => c.text('open'));
  const res = await app.request('/x', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('requireGuest lets unauthenticated requests through', async () => {
  const app = withAuth(requireGuest, (c) => c.text('open'));
  const res = await app.request('/x');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'open');
});

test('currentUser clears a session issued before the revocation marker on the user document', async () => {
  const { id: userId, publicId } = await makeUser({ sessionExpirationTimestamp: Date.now() });
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const cookie = makeSessionCookie({ publicId, issuedAt: Date.now() - 60_000 });
  const res = await app.request('/who', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null }, 'a revoked session must not resolve to a user');
  assert.match(res.headers.get('set-cookie'), /(Max-Age=0|expires=Thu, 01 Jan 1970)/i);
});

test('currentUser keeps a session issued after the revocation marker on the user document', async () => {
  const { id: userId, publicId } = await makeUser({ sessionExpirationTimestamp: Date.now() - 60_000 });
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const res = await app.request('/who', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.deepEqual(await res.json(), { user: resolvedUser(userId, publicId) });
});

test('currentUser rejects a session cookie older than the session TTL', async () => {
  const { id: userId, publicId } = await makeUser();
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  // A captured cookie replayed past its TTL: the browser's Max-Age is no
  // obstacle to an attacker, so the age has to be rejected server-side.
  const stale = Date.now() - (config.sessionTtlSeconds * 1000 + 1000);
  const res = await app.request('/who', {
    headers: { cookie: `session=${makeSessionCookie({ publicId, issuedAt: stale })}` }
  });
  assert.deepEqual(await res.json(), { user: null });
});

// A DB read failure can't be reproduced against a real, healthy embedded
// PGlite instance - the fail-closed branch (src/middleware/auth.js:
// "profile.error") is exercised only by this comment now, not a live test.

// The pointer rides the same read, which is what keeps its resolution free.
test('currentUser carries the personal workspace pointer, and null when there is none yet', async () => {
  const { id: userId, publicId } = await makeUser({ personalWorkspaceId: 2345 });
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const withPointer = await app.request('/who', {
    headers: { cookie: `session=${makeSessionCookie({ publicId })}` }
  });
  assert.equal((await withPointer.json()).user.personalWorkspaceId, 2345);
});

test('currentUser carries the personal workspace pointer as null when there is none yet', async () => {
  const { id: userId, publicId } = await makeUser();
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const res = await app.request('/who', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.equal((await res.json()).user.personalWorkspaceId, null);
});

test('currentUser carries the active workspace from the session, and null when none is chosen', async () => {
  const { id: userId, publicId } = await makeUser();
  const app = withAuth(requireUser, (c) => c.json({ activeWorkspaceId: c.get('user').activeWorkspaceId }));
  const chosen = await app.request('/x', {
    headers: { cookie: `session=${makeSessionCookie({ publicId, activeWorkspaceId: 6789 })}` }
  });
  assert.deepEqual(await chosen.json(), { activeWorkspaceId: 6789 });
  const none = await app.request('/x', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.deepEqual(await none.json(), { activeWorkspaceId: null });
});

// Every page behind requireUser resolves a workspace, and none of them is a redirect
// that could repair a missing workspace first, so the invariant belongs here.
test('requireUser builds the workspace when the pointer is unset, and puts it on the user', async () => {
  const { id: userId, publicId } = await makeUser();
  const app = withAuth(requireUser, (c) => c.json({ personalWorkspaceId: c.get('user').personalWorkspaceId }));
  const res = await app.request('/x', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.equal(res.status, 200);
  assert.ok(Number.isSafeInteger((await res.json()).personalWorkspaceId));
});

test('requireUser answers 503 when the workspace cannot be built', async () => {
  const { id: userId, publicId } = await makeUser();
  // A personal workspace exists but the pointer was never set, so the
  // one-personal-workspace-per-owner index rejects the second insert.
  await createWorkspace({ name: 'Personal', ownerId: userId, personal: true });
  const app = withAuth(requireUser, (c) => c.text('should not be reached'));
  const res = await app.request('/x', { headers: { cookie: `session=${makeSessionCookie({ publicId })}` } });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Unable to prepare your workspace/);
});

test('currentUser clears a session whose user row is gone', async () => {
  const app = new Hono();
  app.get('/who', async (c) => c.json({ user: await currentUser(c) }));
  const res = await app.request('/who', { headers: { cookie: `session=${makeSessionCookie()}` } });
  assert.deepEqual(await res.json(), { user: null });
  assert.match(res.headers.get('set-cookie'), /(Max-Age=0|expires=Thu, 01 Jan 1970)/i);
});

test('requireUser redirects a session whose user row is gone to /signin', async () => {
  const app = withAuth(requireUser, (c) => c.text('secret'));
  const res = await app.request('/x', { headers: { cookie: `session=${makeSessionCookie()}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});
