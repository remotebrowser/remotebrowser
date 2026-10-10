import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./grid.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { launchBrowserInstance } = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/browsers', routes);
  return app;
};

test('GET /browsers/grid redirects an unauthenticated visitor to /signin', async () => {
  const res = await setupApp().request('/browsers/grid');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/grid renders each browser as a card with its name', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const workspace = await ensurePersonalWorkspace({
    userId: created.data.id,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  await launchBrowserInstance({
    workspaceId: workspace.data.workspaceId,
    userId: created.data.id,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const cookie = createSessionCookie({
    publicId: created.data.publicId,
    email: 'user@example.com',
    issuedAt: Date.now()
  });
  const res = await setupApp().request('/browsers/grid', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="browser-grid"/);
  assert.match(body, /class="browser-grid-name" title="calm-otter">calm-otter</);
});
