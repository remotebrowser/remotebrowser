import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../auth/signing.js');
const { latestSignInCode } = await import('../auth/magic.js');
const { routes } = await import('./sent.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/sent', routes);
  return app;
};

// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;

const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

test('POST /sent rejects a missing or invalid CSRF token', async () => {
  const app = setupApp();
  const res = await app.request('/sent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'user@example.com', csrf: 'bogus' }).toString()
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Your session expired/);
});

test('POST /sent rejects a missing email', async () => {
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/sent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `csrf_id=${csrfId}` },
    body: new URLSearchParams({
      email: '',
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /valid email address is required/);
});

test('POST /sent records a sign-in code, sets the signin_email cookie, and normalizes the email', async () => {
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const res = await app.request('/sent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `csrf_id=${csrfId}` },
    body: new URLSearchParams({
      email: 'User@Example.com',
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /user@example\.com/);
  assert.match(res.headers.get('set-cookie') || '', /^signin_email=/);
  // Dev mode keeps the latest code so it can be read back; the code was recorded.
  assert.ok(latestSignInCode('user@example.com'), 'a sign-in code should be registered');
});
