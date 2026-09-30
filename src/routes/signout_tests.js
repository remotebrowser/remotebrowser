import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../auth/signing.js');
const { createSessionCookie } = await import('../auth/session.js');
const { routes } = await import('./signout.js');
const { findOrCreateUser, getUser } = await import('../models/users.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/signout', routes);
  return app;
};

// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;

const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

test('POST /signout without a valid CSRF token is rejected rather than reported as a sign-out', async () => {
  const app = setupApp();
  const res = await app.request('/signout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'bogus' }).toString()
  });
  // Regression: this used to fall through to the same 303 as a successful sign-out.
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('POST /signout with a valid CSRF token clears the session cookie and redirects home', async () => {
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/signout', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.match(res.headers.get('set-cookie'), /^session=;.*Max-Age=0/);
});

test('POST /signout writes the revocation marker so other copies of the cookie stop working', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const userId = created.data.id;
  const before = Date.now();

  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = createSessionCookie({
    publicId: created.data.publicId,
    email: 'user@example.com',
    issuedAt: Date.now()
  });
  const res = await app.request('/signout', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 303);

  const user = await getUser({ id: userId });
  assert.ok(
    Math.abs(user.data.sessionExpirationTimestamp - before) < 5000,
    'signing out must revoke, not just drop the cookie in this browser'
  );
});
