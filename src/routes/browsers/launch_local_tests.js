import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { consola } from 'consola/basic';

process.env.PGLITE_DATA_DIR = 'memory://';
// No external fleet: launches go to the in-process QEMU VM manager, which
// needs the snapshot that the server saves at startup, and takes a proxy.
process.env.BROWSERFLEET_URL = '';

const { routes } = await import('./launch.js');
const { setVmClient, createVmClient } = await import('../../vm/index.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { listBrowserInstancesByWorkspace } = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => {
  setVmClient(createVmClient());
  await closeDatabase();
});

const setupApp = () => {
  const app = new Hono();
  app.route('/browsers', routes);
  return app;
};

// A VM client that records each launch; with no real VM, the launch stops there.
const fakeVms = (canLaunchBrowser = async () => true) => {
  const launches = [];
  setVmClient({
    canLaunchBrowser,
    launchBrowser: async (options) => {
      launches.push(options);
      throw new Error('no VM in tests');
    }
  });
  return launches;
};

let userPublicId;
const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userPublicId = created.data.publicId;
  const workspace = await ensurePersonalWorkspace({
    userId: created.data.id,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  return workspace.data.workspaceId;
};
const sessionCookie = () =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now() });
const csrfToken = (csrfId) => {
  const expires = Date.now() + 15 * 60 * 1000;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

const postLaunch = (workspaceId, fields) => {
  const csrfId = 'a'.repeat(32);
  return setupApp().request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${sessionCookie()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'calm-otter',
      workspace: workspaceId,
      csrf: csrfToken(csrfId),
      ...fields
    }).toString()
  });
};

// Waits until the launch that runs after the response has reached the VM client.
const settle = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
};

test('GET /browsers/launch renders an enabled form when a VM can be launched', async () => {
  fakeVms(async () => true);
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${sessionCookie()}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="btn-primary">Launch<\/button>/);
  assert.doesNotMatch(body, /still being prepared/);
});

test('GET /browsers/launch says to come back later while there is no snapshot yet', async () => {
  fakeVms(async () => false);
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${sessionCookie()}` } });
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
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${sessionCookie()}` } });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /still being prepared/);
  assert.match(errors.join('\n'), /no accel/);
});

test('POST /browsers/launch refuses, without writing an instance, while there is no snapshot yet', async () => {
  const launches = fakeVms(async () => false);
  const workspaceId = await makeUser();
  const res = await postLaunch(workspaceId, { description: 'For QA' });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /still being prepared/);
  assert.match(body, /id="name" name="name" value="calm-otter"/);
  assert.match(body, /id="description" name="description" value="For QA"/);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
  assert.deepEqual(launches, []);
});

test('GET /browsers/launch offers an unchecked proxy box after the checkboxes, with the URL input next to it', async () => {
  fakeVms();
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${sessionCookie()}` } });
  const body = await res.text();
  assert.match(body, /<input type="checkbox" id="useProxy" name="useProxy" \/>\s*Use proxy\s*<\/label>/);
  assert.match(body, /id="proxy"\s+name="proxy"\s+value=""/);
  const at = (text) => body.indexOf(text);
  assert.ok(at('name="blockAdsAndTrackers"') < at('name="useProxy"'));
  assert.ok(at('name="useProxy"') < at('name="proxy"'));
  assert.ok(at('name="proxy"') < at('>Launch</button>'));
  // Enabled in markup, for a visitor without JavaScript; the script disables it.
  assert.doesNotMatch(body, /id="proxy"[^>]*disabled/);
  assert.match(body, /proxyInput\.disabled = !useProxy\.checked/);
});

test('POST /browsers/launch passes the proxy to the new VM when the box is checked', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  const res = await postLaunch(workspaceId, { useProxy: 'on', proxy: ' http://u:p@Proxy.example.com:8080 ' });
  assert.equal(res.status, 303);
  assert.ok(await settle(() => launches.length > 0));
  assert.deepEqual(launches, [{ proxy: 'http://u:p@proxy.example.com:8080' }]);
  // Kept with the browser, so the REST API can report it, but never with the password.
  const [browser] = (await listBrowserInstancesByWorkspace({ workspaceId })).data;
  assert.deepEqual(browser.config, { proxy: 'http://u:****@proxy.example.com:8080' });
});

test('POST /browsers/launch ignores the proxy URL when the box is not checked', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  // As a visitor without JavaScript can send it: the input is never disabled.
  assert.equal((await postLaunch(workspaceId, { proxy: 'not a url' })).status, 303);
  assert.ok(await settle(() => launches.length > 0));
  assert.deepEqual(launches, [{ proxy: null }]);
});

test('POST /browsers/launch asks for the URL when the box is checked but the input is empty', async () => {
  fakeVms();
  const workspaceId = await makeUser();
  const res = await postLaunch(workspaceId, { useProxy: 'on', proxy: '  ' });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Enter the proxy URL, or uncheck Use proxy\./);
  assert.match(body, /id="useProxy" name="useProxy" checked/);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
});

test('POST /browsers/launch refuses a bad proxy URL, keeps what was typed, and creates nothing', async () => {
  fakeVms();
  const workspaceId = await makeUser();
  const res = await postLaunch(workspaceId, {
    useProxy: 'on',
    proxy: 'https://proxy.example.com',
    description: 'For QA'
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /The proxy URL must start with http:\/\/, socks4:\/\/, or socks5:\/\/\./);
  assert.match(body, /id="useProxy" name="useProxy" checked/);
  assert.match(body, /value="https:\/\/proxy.example.com"/);
  assert.match(body, /value="For QA"/);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
});
