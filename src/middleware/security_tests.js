import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import mountSecurity from './security.js';

const setupApp = () => {
  const app = new Hono();
  mountSecurity(app);
  app.get('/health', (c) => c.text('ok'));
  return app;
};

test('secureHeaders sets Content-Security-Policy with expected directives', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  const csp = res.headers.get('content-security-policy');

  assert.equal(res.status, 200);
  assert.ok(csp, 'CSP header should be present');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  // A bare 'self' would still match a header carrying the per-request nonce
  // token after it, so pin the whole directive value instead of a prefix.
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'; /);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unpkg\.com/);
});

test('secureHeaders does not permit any other-origin styles', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /style-src 'self'/);
  assert.doesNotMatch(csp, /style-src [^;]*https:/);
});

test('bodyLimit rejects a body larger than 16 KB with 413', async () => {
  const app = setupApp();
  const big = 'x'.repeat(16 * 1024 + 1);
  const res = await app.request('/health', {
    method: 'POST',
    body: big,
    headers: { 'content-type': 'text/plain' }
  });
  assert.equal(res.status, 413);
  assert.equal(await res.text(), 'Request body too large');
});

test('bodyLimit allows a body at the 16 KB boundary', async () => {
  const app = setupApp();
  const exact = 'x'.repeat(16 * 1024);
  app.post('/echo', (c) => c.text(c.req.raw.body ? 'ok' : 'ok'));
  const res = await app.request('/echo', {
    method: 'POST',
    body: exact,
    headers: { 'content-type': 'text/plain' }
  });
  assert.equal(res.status, 200);
});

test('Permissions-Policy denies sensitive browser features', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  const permissionsPolicy = res.headers.get('permissions-policy');

  assert.ok(permissionsPolicy, 'Permissions-Policy header should be present');
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
    assert.match(permissionsPolicy, new RegExp(`${feature}=\\(\\)`));
  }
});

test('Permissions-Policy allows clipboard-write for this origin, still denies clipboard-read', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  const permissionsPolicy = res.headers.get('permissions-policy');

  // clipboard.writeText must stay allow-listed for the Copy button.
  assert.match(permissionsPolicy, /clipboard-write=\(self\)/);
  assert.match(permissionsPolicy, /clipboard-read=\(\)/);
});

test('Cache-Control defaults to private, no-store when a route sets none', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

test('Cache-Control keeps an explicit value already set by a route', async () => {
  const app = setupApp();
  app.get('/cached', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.text('ok');
  });
  const res = await app.request('/cached');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
});

test('secureHeaders hardens cross-origin embedding', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
});

test('script-src nonce is freshly generated per request', async () => {
  const app = setupApp();
  const nonceOf = (csp) => csp.match(/script-src 'self' '(nonce-[^']+)'/)[1];
  const first = nonceOf((await app.request('/health')).headers.get('content-security-policy'));
  const second = nonceOf((await app.request('/health')).headers.get('content-security-policy'));
  assert.notEqual(first, second, 'a reused nonce would let a leaked one authorize scripts on later responses');
});
