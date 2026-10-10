import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import { routes } from './static.js';

const setupApp = () => {
  const app = new Hono();
  app.route('/', routes);
  return app;
};

test('GET /style.css serves the stylesheet as CSS', async () => {
  const app = setupApp();
  const res = await app.request('/style.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/css/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
});

test('GET /robots.txt serves plain text', async () => {
  const app = setupApp();
  const res = await app.request('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.match(await res.text(), /User-agent:/);
});

test('GET /htmx.min.js serves the script as JavaScript', async () => {
  const app = setupApp();
  const res = await app.request('/htmx.min.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
});

test('GET /screencast.js serves the script as JavaScript', async () => {
  const app = setupApp();
  const res = await app.request('/screencast.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
});

test('GET /tagline.js serves the script as JavaScript', async () => {
  const app = setupApp();
  const res = await app.request('/tagline.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
});

test('GET /theme.js serves the script as JavaScript', async () => {
  const app = setupApp();
  const res = await app.request('/theme.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
});

test('GET /terms serves the terms page as HTML', async () => {
  const app = setupApp();
  const res = await app.request('/terms');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
});

test('GET /privacy-policy serves the privacy policy as HTML', async () => {
  const app = setupApp();
  const res = await app.request('/privacy-policy');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
});

test('unknown static path is not found', async () => {
  const app = setupApp();
  const res = await app.request('/missing.css');
  assert.equal(res.status, 404);
});

test('GET /favicon.ico serves the icon without a charset', async () => {
  const app = setupApp();
  const res = await app.request('/favicon.ico');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/x-icon');
});

test('GET /fonts/figtree-variable.woff2 serves the font as woff2 without a charset', async () => {
  const app = setupApp();
  const res = await app.request('/fonts/figtree-variable.woff2');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
});
