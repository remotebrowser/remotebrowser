import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { consola } from 'consola/basic';

process.env.PGLITE_DATA_DIR = 'memory://';

const { generateBrowserName, startBrowser, INITIAL_URLS } = await import('./launch.js');

test('generateBrowserName produces an "adjective-animal" name', () => {
  const name = generateBrowserName();
  assert.match(name, /^[a-z]+-[a-z]+$/);
});

test('generateBrowserName produces varied names across calls', () => {
  const names = new Set(Array.from({ length: 50 }, () => generateBrowserName()));
  assert.ok(names.size > 1);
});

const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { routes } = await import('./launch.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const {
  MAX_BROWSER_LAUNCHES_PER_MINUTE,
  launchBrowserInstance,
  recordProvisionedBrowser,
  getBrowserInstance,
  getBrowserInstanceByPublicId,
  browserIdForHandle,
  listBrowserInstancesByWorkspace
} = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');
const { setVmClient, createVmClient } = await import('../../vm/index.js');

// A VM client with no real VMs: a launch gets `foobar`, which has no CDP URL,
// so nothing is ever dialed. It records the options of each launch.
const fakeVms = ({
  launchBrowser = async () => ({ browserId: 'foobar' }),
  canLaunchBrowser = async () => true
} = {}) => {
  const launches = [];
  setVmClient({
    canLaunchBrowser,
    launchBrowser: async (options) => {
      launches.push(options);
      return launchBrowser(options);
    },
    browserIsRunning: async () => true,
    resolveCdpUrl: async () => null
  });
  return launches;
};

test.beforeEach(() => fakeVms());
test.afterEach(async () => {
  setVmClient(createVmClient());
  await closeDatabase();
});

const setupApp = () => {
  const app = new Hono();
  app.route('/browsers', routes);
  return app;
};

let userId;
let userPublicId;

const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

// Seeds the signed-in user and its personal workspace, and returns the
// generated workspace id.
const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const workspace = await ensurePersonalWorkspace({ userId, email: 'user@example.com', personalWorkspaceId: null });
  return workspace.data.workspaceId;
};

const makeSharedWorkspace = async ({ workspaceId, role = 'User' } = {}) => {
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId });
  await createCollaborator({
    workspaceId,
    userId,
    email: 'user@example.com',
    role,
    workspaceName: 'Acme Corp'
  });
};

// A browser row that startBrowser can legitimately provision further.
const makeLaunchedInstance = async ({ workspaceId }) => {
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  return launched.data.browserInstanceId;
};

// POST starts browser without awaiting; a DB write triggered by it may still
// be in flight when the request handler returns, so poll for it.
const settle = async (predicate) => {
  for (let i = 0; i < 100; i += 1) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
};

const captureErrors = () => {
  const original = consola.error;
  const messages = [];
  consola.error = (...args) => messages.push(args.map((arg) => String(arg)).join(' '));
  return {
    messages,
    restore: () => {
      consola.error = original;
    }
  };
};

test('startBrowser records the assigned id and a fresh handle, then indexes the handle', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const launches = fakeVms();
  await startBrowser({ workspaceId, browserInstanceId, userId });
  assert.equal(launches.length, 1, 'a VM should be asked for a browser');

  const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
  assert.equal(fetched.data.internalBrowserId, 'foobar');
  assert.equal(fetched.data.status, 'running');
  const handle = fetched.data.browserHandle;
  assert.match(handle, /^H[23456789abcdefghijkmnpqrstuvwxyz]{36}$/, `not a handle: ${handle}`);

  // Index entry must name the same handle, or the CDP relay could never resolve it.
  assert.deepEqual(await browserIdForHandle({ handle }), { data: 'foobar' });
});

// navigate is injected, not dialed: the call is fire-and-forget.
test('startBrowser navigates the new browser to the initial URL', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const navigateCalls = [];
  const navigate = async (params) => {
    navigateCalls.push(params);
    return { data: true };
  };
  await startBrowser({ workspaceId, browserInstanceId, userId, navigate });
  assert.equal(navigateCalls.length, 1);
  assert.equal(navigateCalls[0].browserId, 'foobar');
  assert.ok(
    INITIAL_URLS.includes(navigateCalls[0].url),
    `expected one of ${INITIAL_URLS.join(', ')}, got ${navigateCalls[0].url}`
  );
});

// Failed navigation is best-effort; must not stop the browser from being recorded.
test('startBrowser still records the browser when navigation fails', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const errors = captureErrors();
  try {
    await startBrowser({
      workspaceId,
      browserInstanceId,
      userId,
      navigate: async () => ({ error: 'CONNECT_TIMEOUT' })
    });
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.notEqual(fetched.data.internalBrowserId, '', 'the handle should still be recorded');
    assert.match(errors.messages.join('\n'), new RegExp(browserInstanceId));
    assert.match(errors.messages.join('\n'), /CONNECT_TIMEOUT/);
  } finally {
    errors.restore();
  }
});

// A handle is a credential. The browser id is fine to log; the handle is not.
test('startBrowser never writes the handle to the log', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const logged = [];
  const originals = { log: consola.log, error: consola.error, warn: consola.warn };
  for (const level of ['log', 'error', 'warn']) {
    consola[level] = (...args) => logged.push(args.map(String).join(' '));
  }
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId });
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    const handle = fetched.data.browserHandle;
    const output = logged.join('\n');
    assert.ok(!output.includes(handle), `the handle leaked into the log: ${output}`);
    assert.match(output, new RegExp(browserInstanceId), 'the browser instance id is still worth logging');
  } finally {
    for (const [level, fn] of Object.entries(originals)) {
      consola[level] = fn;
    }
  }
});

// A mismatched userId is a real, reproducible ownership-hardening failure -
// not one that needs a stubbed database error.
test('startBrowser reports a failure to record the browser when the caller does not own the instance', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const errors = captureErrors();
  try {
    // 0 never matches a real serial id, so this can only be a mismatch.
    await startBrowser({ workspaceId, browserInstanceId, userId: 0 });
    assert.match(errors.messages.join('\n'), new RegExp(browserInstanceId));
    assert.match(errors.messages.join('\n'), /NOT_AUTHORIZED/);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data.internalBrowserId, '', 'an unauthorized caller must not provision the browser');
  } finally {
    errors.restore();
  }
});

test('startBrowser leaves the instance untouched and reports it when no browser could be started', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  fakeVms({
    launchBrowser: async () => {
      throw new Error('at capacity');
    }
  });
  const errors = captureErrors();
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId });
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data.internalBrowserId, '');
    assert.match(errors.messages.join('\n'), new RegExp(browserInstanceId));
    assert.match(errors.messages.join('\n'), /at capacity/);
  } finally {
    errors.restore();
  }
});

// A browser that is somehow already provisioned (a bug, or a replayed call) is
// a real, reproducible failure of recordProvisionedBrowser's write-once guard.
test('startBrowser reports it when the instance was already provisioned', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'already-there',
    userId
  });
  const errors = captureErrors();
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId });
    assert.match(errors.messages.join('\n'), new RegExp(browserInstanceId));
    assert.match(errors.messages.join('\n'), /ALREADY_PROVISIONED/);
  } finally {
    errors.restore();
  }
});

test('GET /browsers/launch redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/launch');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test("GET /browsers/launch renders the form in the visitor's own workspace", async () => {
  const workspaceId = await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Launch a browser/);
  assert.match(body, /id="name" name="name" value="[a-z]+-[a-z]+"/);
  assert.match(body, /id="enableScreenRecording" name="enableScreenRecording" checked/);
  assert.match(body, /id="blockAdsAndTrackers" name="blockAdsAndTrackers" checked/);
  assert.match(body, /id="description" name="description" value=""/);
  assert.match(body, />Launch<\/button>/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Personal workspace</);
  assert.match(body, /<a href="\/browsers">Browsers<\/a>/);
  assert.match(body, /<span aria-current="page">Launch<\/span>/);
  assert.match(body, new RegExp(`name="workspace" value="${workspaceId}"`));
});

test('GET /browsers/launch redirects to / and clears a stale active workspace', async () => {
  await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 2222 });
  const res = await app.request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('GET /browsers/launch renders the active shared workspace', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333 });
  const app = setupApp();
  const cookie = makeSessionCookie({ activeWorkspaceId: 3333 });
  const res = await app.request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Launch a browser/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /<a href="\/browsers">Browsers<\/a>/);
  assert.match(body, /<span aria-current="page">Launch<\/span>/);
  assert.match(body, /name="workspace" value="3333"/);
});

test('POST /browsers/launch redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/launch', { method: 'POST' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('POST /browsers/launch rejects a missing or invalid CSRF token', async () => {
  const workspaceId = await makeUser();
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `session=${cookie}` },
    body: new URLSearchParams({ name: 'calm-otter', workspace: workspaceId, csrf: 'bogus' }).toString()
  });
  assert.equal(res.status, 403);
});

// requireSubmittedWorkspace runs after CSRF; stale workspace needs valid token.
test('POST /browsers/launch refuses a submission for a workspace the visitor is no longer active in', async () => {
  const workspaceId = await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'calm-otter',
      workspace: 9999,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /active workspace changed/);
  const instances = await listBrowserInstancesByWorkspace({ workspaceId });
  assert.deepEqual(instances.data, [], 'a rejected submission must write nothing');
});

test('POST /browsers/launch rejects a blank name and preserves the description', async () => {
  const workspaceId = await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: '',
      description: 'For QA',
      workspace: workspaceId,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /browser name/i);
  assert.match(body, /id="description" name="description" value="For QA"/);
});

test('POST /browsers/launch writes a browser instance and redirects to its browser page', async () => {
  const workspaceId = await makeUser();
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'calm-otter',
      description: 'For QA testing',
      enableScreenRecording: 'on',
      workspace: workspaceId,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  const publicId = res.headers.get('location').split('/').pop();

  const fetched = await getBrowserInstanceByPublicId({ workspaceId, publicId });
  assert.equal(fetched.data.browserName, 'calm-otter');
  // browserDescription isn't part of the model getter's shape (see
  // src/models/browsers.js's map()), so it isn't asserted here.

  const settled = await settle(async () => {
    const r = await getBrowserInstanceByPublicId({ workspaceId, publicId });
    return r.data.internalBrowserId !== '' ? r : null;
  });
  assert.ok(settled, 'launching a browser should start one in a VM and record its id');
  assert.equal(settled.data.status, 'running');
});

// Deleting a Workspace/Collaborator while the pointer still named the
// workspace, then watching the launch self-heal and retry, cannot be set up
// anymore: the FK from users.personal_workspace_id to workspaces forbids
// deleting a workspace a user still points at. The repair codepath itself
// (ensureWorkspaceForRepair, shared with
// listBrowserInstancesByWorkspace/getBrowserInstance) is covered directly in
// src/models/browsers_tests.js.

// Deleting a shared workspace cascades to its collaborators row too, so the
// visitor would be refused before ever reaching the launch write - there is no
// way to reach "the write was refused, and no repair was attempted" honestly
// against a real database. The one thing worth keeping - that a shared
// workspace's repair param is always null - is visible directly in
// src/routes/browsers/launch.js.

test('POST /browsers/launch writes a browser instance scoped to the active workspace and redirects there', async () => {
  await makeUser();
  await makeSharedWorkspace({ workspaceId: 3333 });
  const app = setupApp();
  const csrfId = 'a'.repeat(32);
  const cookie = makeSessionCookie({ activeWorkspaceId: 3333 });
  const res = await app.request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookie}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'calm-otter',
      blockAdsAndTrackers: 'on',
      workspace: 3333,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  const publicId = res.headers.get('location').split('/').pop();
  const fetched = await getBrowserInstanceByPublicId({ workspaceId: 3333, publicId });
  assert.ok(fetched.data, 'the recorded instance should land on the workspace-scoped row');

  const settled = await settle(async () => {
    const r = await getBrowserInstanceByPublicId({ workspaceId: 3333, publicId });
    return r.data.internalBrowserId !== '' ? r : null;
  });
  assert.ok(settled, 'the id should be recorded on the workspace-scoped instance');
});

// Fills the workspace's rate with launches made a moment ago, so the next is over it.
const fillLaunchRate = async (workspaceId) => {
  const { getDatabase } = await import('../../db/database.js');
  await (
    await getDatabase()
  ).query(
    'INSERT INTO browser_launches(workspace_id,user_id,launched_timestamp) SELECT $1,$2,$3 FROM generate_series(1,$4)',
    [workspaceId, userId, Date.now() - 1000, MAX_BROWSER_LAUNCHES_PER_MINUTE]
  );
};

test('POST /browsers/launch answers 429 with Retry-After once the workspace is over the launch rate', async () => {
  const workspaceId = await makeUser();
  await fillLaunchRate(workspaceId);
  const before = (await listBrowserInstancesByWorkspace({ workspaceId })).data.length;
  const csrfId = 'a'.repeat(32);
  const res = await setupApp().request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${makeSessionCookie()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name: 'calm-otter', workspace: workspaceId, csrf: makeCsrfToken(csrfId) }).toString()
  });
  assert.equal(res.status, 429);
  assert.match(res.headers.get('retry-after'), /^\d+$/);
  assert.match(
    await res.text(),
    /This workspace launched too many browsers in the last minute\. Please try again in \d+ seconds?\./
  );
  assert.equal((await listBrowserInstancesByWorkspace({ workspaceId })).data.length, before);
});

const postLaunch = (workspaceId, fields) => {
  const csrfId = 'a'.repeat(32);
  return setupApp().request('/browsers/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${makeSessionCookie()}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({
      name: 'calm-otter',
      workspace: workspaceId,
      csrf: makeCsrfToken(csrfId),
      ...fields
    }).toString()
  });
};

test('GET /browsers/launch renders an enabled form when a VM can be launched', async () => {
  fakeVms();
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${makeSessionCookie()}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="btn-primary">Launch<\/button>/);
  assert.doesNotMatch(body, /still being prepared/);
});

test('GET /browsers/launch says to come back later while there is no snapshot yet', async () => {
  fakeVms({ canLaunchBrowser: async () => false });
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${makeSessionCookie()}` } });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /role="alert"[^>]*>Browsers are still being prepared/);
  assert.match(body, /class="btn-primary" disabled>Launch<\/button>/);
});

test('GET /browsers/launch logs a failed check and says to come back later', async (t) => {
  const errors = [];
  t.mock.method(consola, 'error', (message) => errors.push(message));
  fakeVms({
    canLaunchBrowser: async () => {
      throw new Error('no accel');
    }
  });
  await makeUser();
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${makeSessionCookie()}` } });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /still being prepared/);
  assert.match(errors.join('\n'), /no accel/);
});

test('POST /browsers/launch refuses, without writing an instance, while there is no snapshot yet', async () => {
  const launches = fakeVms({ canLaunchBrowser: async () => false });
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
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${makeSessionCookie()}` } });
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
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${makeSessionCookie()}` } });
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
  const res = await setupApp().request('/browsers/launch', { headers: { cookie: `session=${makeSessionCookie()}` } });
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
