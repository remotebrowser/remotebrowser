import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../auth/session.js');
const { routes } = await import('./signin.js');
const { findOrCreateUser } = await import('../models/users.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/signin', routes);
  return app;
};

const makeSessionCookie = (publicId, over = {}) =>
  createSessionCookie({ publicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

test('GET /signin renders the sign-in form for anonymous visitors', async () => {
  const app = setupApp();
  const res = await app.request('/signin');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /action="\/sent"/);
});

test('GET /signin redirects an authenticated user to /', async () => {
  // A real user row: a session naming nobody is treated as signed out.
  const { data } = await findOrCreateUser({ email: 'user@example.com' });
  const app = setupApp();
  const cookie = makeSessionCookie(data.publicId);
  const res = await app.request('/signin', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});
