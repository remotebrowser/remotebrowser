import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { consola } from 'consola/basic';

process.env.PGLITE_DATA_DIR = 'memory://';
// No external fleet: launches go to the in-process QEMU VM manager, which
// needs the snapshot that the server saves at startup.
process.env.BROWSERFLEET_URL = '';

const { routes } = await import('./launch.js');
const { setVmClient } = await import('../../vm/index.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { listBrowserInstancesByWorkspace } = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/browsers', routes);
  return app;
};

const fakeVms = (canLaunchBrowser) =>
  setVmClient({
    canLaunchBrowser,
    launchBrowser: async () => {
      throw new Error('not expected');
    }
  });

const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const workspace = await ensurePersonalWorkspace({
    userId: created.data.id,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  const cookie = createSessionCookie({
    publicId: created.data.publicId,
    email: 'user@example.com',
    issuedAt: Date.now()
  });
  return { workspaceId: workspace.data.workspaceId, cookie };
};

const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + 15 * 60 * 1000;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

test('GET /browsers/launch renders an enabled form when a VM can be launched', async () => {
  fakeVms(async () => true);
  const { cookie } = await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="btn-primary">Launch<\/button>/);
  assert.doesNotMatch(body, /still being prepared/);
});

test('GET /browsers/launch says to come back later while there is no snapshot yet', async () => {
  fakeVms(async () => false);
  const { cookie } = await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /role="alert"[^>]*>Browsers are still being prepared/);
  assert.match(body, /class="btn-primary" disabled>Launch<\/button>/);
});

test('GET /browsers/launch logs a failed check and says to come back later', async (t) => {
  const errors = [];
  t.mock.method(consola, 'error', (message) => errors.push(message));
  fakeVms(async () => {
    throw new Error('no accel');
  });
  const { cookie } = await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /still being prepared/);
  assert.match(errors.join('\n'), /no accel/);
});

test('POST /browsers/launch refuses, without writing an instance, while there is no snapshot yet', async () => {
  fakeVms(async () => false);
  const { workspaceId, cookie } = await makeUser();
  const csrfId = 'a'.repeat(32);
  const res = await setupApp().request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'calm-otter',
      description: 'For QA',
      workspace: workspaceId,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /still being prepared/);
  assert.match(body, /id="name" name="name" value="calm-otter"/);
  assert.match(body, /id="description" name="description" value="For QA"/);
  const listed = await listBrowserInstancesByWorkspace({ workspaceId });
  assert.deepEqual(listed.data, []);
});
