import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

const { sign } = await import('./signing.js');
const { ensureCsrfId, createCsrfToken, rotateCsrfToken, verifyCsrfToken } = await import('./csrf.js');

const withRoute = (handler) => {
  const app = new Hono();
  app.get('/x', handler);
  return app;
};

test('ensureCsrfId issues a new 32-char hex id and sets the csrf_id cookie when none exists', async () => {
  const app = withRoute((c) => c.text(ensureCsrfId(c)));
  const res = await app.request('/x');
  const id = await res.text();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.match(res.headers.get('set-cookie') || '', new RegExp(`^csrf_id=${id}.*HttpOnly`));
});

test('ensureCsrfId reuses an existing valid csrf_id cookie without setting a new one', async () => {
  const existing = 'a'.repeat(32);
  const app = withRoute((c) => c.text(ensureCsrfId(c)));
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${existing}` } });
  assert.equal(await res.text(), existing);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('ensureCsrfId replaces a malformed csrf_id cookie', async () => {
  const app = withRoute((c) => c.text(ensureCsrfId(c)));
  const res = await app.request('/x', { headers: { cookie: 'csrf_id=not-a-valid-id' } });
  const id = await res.text();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.ok(res.headers.get('set-cookie'));
});

test('createCsrfToken produces a token that verifyCsrfToken accepts for the same csrf_id', async () => {
  const csrfId = 'b'.repeat(32);
  const app = withRoute((c) => {
    const token = createCsrfToken(c);
    return c.json({ valid: verifyCsrfToken(c, token) });
  });
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${csrfId}` } });
  assert.equal((await res.json()).valid, true);
});

test('rotateCsrfToken sets a new csrf_id cookie and produces a token bound to it, not the request cookie', async () => {
  const oldId = 'a'.repeat(32);
  const app = withRoute((c) => c.json({ token: rotateCsrfToken(c) }));
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${oldId}` } });
  const setCookie = res.headers.get('set-cookie') || '';
  assert.ok(setCookie.startsWith('csrf_id='), 'rotateCsrfToken must set a fresh csrf_id cookie');
  const newId = setCookie.slice('csrf_id='.length).split(';')[0];
  assert.notEqual(newId, oldId);
  const { token } = await res.json();
  // Verifying against the new id (what the response actually sets) must
  // succeed; verifying against the old, pre-rotation id must not.
  const withCookieApp = withRoute((c) => c.json({ valid: verifyCsrfToken(c, token) }));
  const validRes = await withCookieApp.request('/x', { headers: { cookie: `csrf_id=${newId}` } });
  assert.equal((await validRes.json()).valid, true);
  const invalidRes = await withCookieApp.request('/x', { headers: { cookie: `csrf_id=${oldId}` } });
  assert.equal((await invalidRes.json()).valid, false);
});

test('verifyCsrfToken rejects when there is no csrf_id cookie', async () => {
  const app = withRoute((c) => c.json({ valid: verifyCsrfToken(c, 'whatever') }));
  const res = await app.request('/x');
  assert.equal((await res.json()).valid, false);
});

test('verifyCsrfToken rejects a non-string token', async () => {
  const app = withRoute((c) => c.json({ valid: verifyCsrfToken(c, undefined) }));
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${'a'.repeat(32)}` } });
  assert.equal((await res.json()).valid, false);
});

test('verifyCsrfToken rejects a malformed token', async () => {
  const app = withRoute((c) => c.json({ valid: verifyCsrfToken(c, 'not-a-token') }));
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${'c'.repeat(32)}` } });
  assert.equal((await res.json()).valid, false);
});

test('verifyCsrfToken rejects an expired token', async () => {
  const csrfId = 'd'.repeat(32);
  const expires = Date.now() - 1000;
  const token = `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
  const app = withRoute((c) => c.json({ valid: verifyCsrfToken(c, token) }));
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${csrfId}` } });
  assert.equal((await res.json()).valid, false);
});

test('verifyCsrfToken rejects a token signed for a different csrf_id', async () => {
  const otherId = 'e'.repeat(32);
  const expires = Date.now() + 1000;
  const token = `${expires}.${sign(`csrf.${otherId}.${expires}`)}`;
  const app = withRoute((c) => c.json({ valid: verifyCsrfToken(c, token) }));
  const res = await app.request('/x', { headers: { cookie: `csrf_id=${'f'.repeat(32)}` } });
  assert.equal((await res.json()).valid, false);
});
