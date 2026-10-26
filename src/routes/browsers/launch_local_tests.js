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

test('GET /browsers/launch offers the screen resolutions after the description, with Full HD chosen', async () => {
  fakeVms();
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${sessionCookie()}` } });
  const body = await res.text();
  assert.match(body, /<span id="screenResolutionLabel" class="field-label">Screen resolution<\/span>/);
  assert.match(body, /role="radiogroup" aria-labelledby="screenResolutionLabel"/);
  const options = [
    ...body.matchAll(
      /<input type="radio" name="screenResolution" value="([^"]+)"( checked)? \/>\s*<span>([^<]*) <span class="radio-detail">\(([^<]*)\)<\/span>/g
    )
  ].map((m) => m.slice(1));
  assert.deepEqual(options, [
    ['full-hd', ' checked', 'Full HD', '1920×1080'],
    ['wuxga', undefined, 'WUXGA', '1920×1200'],
    ['qhd', undefined, 'QHD', '2560×1440'],
    ['4k', undefined, '4K', '3840×2160']
  ]);
  const at = (text) => body.indexOf(text);
  assert.ok(at('name="description"') < at('name="screenResolution"'));
  assert.ok(at('name="screenResolution"') < at('name="enableScreenRecording"'));
});

test('GET /browsers/launch offers a screen scale slider after the screen resolutions, at 150%', async () => {
  fakeVms();
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${sessionCookie()}` } });
  const body = await res.text();
  assert.match(body, /<label for="screenScale">Screen scale<\/label>/);
  assert.match(
    body,
    /<input\s+type="range"\s+id="screenScale"\s+name="screenScale"\s+min="100"\s+max="200"\s+step="25"\s+value="150"\s+list="screenScaleStops"\s+aria-valuetext="150%"\s+\/>/
  );
  assert.match(body, /<output id="screenScaleValue" for="screenScale">150%<\/output>/);
  const stops = [...body.matchAll(/<option value="(\d+)" label="([^"]+)"><\/option>/g)].map((m) => m.slice(1));
  assert.deepEqual(stops, [
    ['100', '100%'],
    ['125', '125%'],
    ['150', '150%'],
    ['175', '175%'],
    ['200', '200%']
  ]);
  const at = (text) => body.indexOf(text);
  assert.ok(at('name="screenResolution"') < at('name="screenScale"'));
  assert.ok(at('name="screenScale"') < at('name="enableScreenRecording"'));
});

test('POST /browsers/launch sets the chosen screen scale, and nothing for 150%', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  for (const screenScale of ['175', '150']) {
    assert.equal((await postLaunch(workspaceId, { screenScale })).status, 303);
    assert.ok(await settle(() => launches.length > 0));
  }
  assert.ok(await settle(() => launches.length > 1));
  assert.deepEqual(launches, [
    { proxy: null, screenResolution: null, screenScale: 175 },
    { proxy: null, screenResolution: null, screenScale: null }
  ]);
});

test('POST /browsers/launch refuses a screen scale off the slider, and keeps the choices', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  const res = await postLaunch(workspaceId, { screenScale: '110', screenResolution: 'qhd' });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Choose a screen scale from 100% to 200%, in steps of 25%\./);
  assert.match(body, /name="screenScale"[^>]*value="150"/);
  assert.match(body, /value="qhd" checked/);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
  assert.deepEqual(launches, []);
});

test('POST /browsers/launch keeps the chosen screen scale when it shows an error', async () => {
  fakeVms();
  const workspaceId = await makeUser();
  const res = await postLaunch(workspaceId, { screenScale: '200', useProxy: 'on', proxy: '' });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /name="screenScale"[^>]*value="200"/);
  assert.match(body, /<output id="screenScaleValue" for="screenScale">200%<\/output>/);
});

test('POST /browsers/launch sets the chosen screen resolution', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  for (const screenResolution of ['wuxga', '4k']) {
    assert.equal((await postLaunch(workspaceId, { screenResolution })).status, 303);
  }
  assert.ok(await settle(() => launches.length > 1));
  assert.deepEqual(launches, [
    { proxy: null, screenResolution: { width: 1920, height: 1200 }, screenScale: null },
    { proxy: null, screenResolution: { width: 3840, height: 2160 }, screenScale: null }
  ]);
});

test('POST /browsers/launch keeps the image default for Full HD', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  assert.equal((await postLaunch(workspaceId, { screenResolution: 'full-hd' })).status, 303);
  assert.ok(await settle(() => launches.length > 0));
  assert.deepEqual(launches, [{ proxy: null, screenResolution: null, screenScale: null }]);
});

test('POST /browsers/launch refuses a screen resolution not in the list, and creates nothing', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  const res = await postLaunch(workspaceId, { screenResolution: '8k', description: 'For QA' });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Choose a screen resolution from the list\./);
  assert.match(body, /value="full-hd" checked/);
  assert.match(body, /value="For QA"/);
  assert.deepEqual((await listBrowserInstancesByWorkspace({ workspaceId })).data, []);
  assert.deepEqual(launches, []);
});

test('POST /browsers/launch keeps the chosen screen resolution when it shows an error', async () => {
  fakeVms();
  const workspaceId = await makeUser();
  const res = await postLaunch(workspaceId, { screenResolution: 'qhd', useProxy: 'on', proxy: '' });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /value="qhd" checked/);
  assert.doesNotMatch(body, /value="full-hd" checked/);
});

test('POST /browsers/launch passes the proxy to the new VM when the box is checked', async () => {
  const workspaceId = await makeUser();
  const launches = fakeVms();
  const res = await postLaunch(workspaceId, { useProxy: 'on', proxy: ' http://u:p@Proxy.example.com:8080 ' });
  assert.equal(res.status, 303);
  assert.ok(await settle(() => launches.length > 0));
  assert.deepEqual(launches, [
    { proxy: 'http://u:p@proxy.example.com:8080', screenResolution: null, screenScale: null }
  ]);
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
  assert.deepEqual(launches, [{ proxy: null, screenResolution: null, screenScale: null }]);
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
