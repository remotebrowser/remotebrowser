import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import { routes } from './health.js';

const setupApp = () => {
  const app = new Hono();
  app.route('/health', routes);
  return app;
};

test('GET /health responds with 200', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  assert.equal(res.status, 200);
});

test('GET /health responds with OK and a timestamp', async () => {
  const app = setupApp();
  const res = await app.request('/health');
  assert.match(await res.text(), /^OK \d+$/);
});
