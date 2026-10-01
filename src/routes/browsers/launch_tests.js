import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { consola } from 'consola/basic';

process.env.PGLITE_DATA_DIR = 'memory://';
// Set before ./launch pulls in ../../config, which freezes what it read.
process.env.BROWSERFLEET_URL = 'http://browserfleet.test';

const { generateBrowserName, startBrowser, INITIAL_URLS } = await import('./launch.js');

test('generateBrowserName produces an "adjective-animal" name', () => {
  const name = generateBrowserName();
  assert.match(name, /^[a-z]+-[a-z]+$/);
});

test('generateBrowserName produces varied names across calls', () => {
  const names = new Set(Array.from({ length: 50 }, () => generateBrowserName()));
  assert.ok(names.size > 1);
});

const { config } = await import('../../config.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { routes } = await import('./launch.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const {
  launchBrowserInstance,
  recordProvisionedBrowser,
  getBrowserInstance,
  getBrowserInstanceByPublicId,
  browserIdForHandle,
  listBrowserInstancesByWorkspace
} = await import('../../models/browsers.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

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

// This app has one real remaining HTTP call: BrowserFleet's /api/v1/browsers,
// the third-party service that actually provisions the browser. Everything
// else in these tests runs against a real, in-memory PGlite database.
const REMOTEBROWSER_CREATE = /\/api\/v1\/browsers$/;

const REMOTEBROWSER_ROUTE = {
  match: REMOTEBROWSER_CREATE,
  responses: [() => new Response(JSON.stringify({ browser_id: 'foobar', ws_url: 'ignored' }), { status: 200 })]
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

const stubFetchByRoute = (routes) => {
  const original = globalThis.fetch;
  const calls = [];
  const counters = new Map();
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const route = routes.find((r) => r.match.test(url));
    if (!route) throw new Error(`Unstubbed fetch call: ${url}`);
    const callIndex = counters.get(route) || 0;
    counters.set(route, callIndex + 1);
    return route.responses[Math.min(callIndex, route.responses.length - 1)]();
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
};

test('startBrowser records the assigned id and a fresh handle, then indexes the handle', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const { calls, restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId });
    const start = calls.find((c) => REMOTEBROWSER_CREATE.test(c.url));
    assert.ok(start, 'the browserfleet server should be asked for a browser');
    assert.equal(start.opts.method, 'POST');

    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data.internalBrowserId, 'foobar');
    assert.equal(fetched.data.status, 'running');
    const handle = fetched.data.browserHandle;
    assert.match(handle, /^H[23456789abcdefghijkmnpqrstuvwxyz]{36}$/, `not a handle: ${handle}`);

    // Index entry must name the same handle, or the CDP relay could never resolve it.
    assert.deepEqual(await browserIdForHandle({ handle }), { data: 'foobar' });
  } finally {
    restore();
  }
});

// navigate is injected, not dialed: the call is fire-and-forget.
test('startBrowser navigates the new browser to the initial URL', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
  const navigateCalls = [];
  const navigate = async (params) => {
    navigateCalls.push(params);
    return { data: true };
  };
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId, navigate });
    assert.equal(navigateCalls.length, 1);
    assert.equal(navigateCalls[0].browserId, 'foobar');
    assert.ok(
      INITIAL_URLS.includes(navigateCalls[0].url),
      `expected one of ${INITIAL_URLS.join(', ')}, got ${navigateCalls[0].url}`
    );
  } finally {
    restore();
  }
});

// Failed navigation is best-effort; must not stop the browser from being recorded.
test('startBrowser still records the browser when navigation fails', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
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
    restore();
  }
});

// A handle is a credential. The browser id is fine to log; the handle is not.
test('startBrowser never writes the handle to the log', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
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
    restore();
  }
});

// A mismatched userId is a real, reproducible ownership-hardening failure -
// not one that needs a stubbed database error.
test('startBrowser reports a failure to record the browser when the caller does not own the instance', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
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
    restore();
  }
});

test('startBrowser leaves the instance untouched and reports it when no browser could be started', async () => {
  const workspaceId = await makeUser();
  const browserInstanceId = await makeLaunchedInstance({ workspaceId });
  const { restore } = stubFetchByRoute([
    {
      match: REMOTEBROWSER_CREATE,
      responses: [() => new Response(JSON.stringify({ detail: 'at capacity' }), { status: 503 })]
    }
  ]);
  const errors = captureErrors();
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId });
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data.internalBrowserId, '');
    assert.match(errors.messages.join('\n'), new RegExp(browserInstanceId));
    assert.match(errors.messages.join('\n'), /HTTP 503/);
  } finally {
    errors.restore();
    restore();
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
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
  const errors = captureErrors();
  try {
    await startBrowser({ workspaceId, browserInstanceId, userId });
    assert.match(errors.messages.join('\n'), new RegExp(browserInstanceId));
    assert.match(errors.messages.join('\n'), /ALREADY_PROVISIONED/);
  } finally {
    errors.restore();
    restore();
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

test('GET /browsers/launch shows the workspace is at capacity and hides the form', async () => {
  const workspaceId = await makeUser();
  for (let i = 0; i < config.maxPersonalBrowsers; i += 1) {
    await launchBrowserInstance({
      workspaceId,
      userId,
      browserName: `browser-${i}`,
      browserDescription: ''
    });
  }
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/browsers/launch', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(`reached its limit of ${config.maxPersonalBrowsers} browsers`));
  assert.doesNotMatch(body, /<form method="post" action="\/browsers\/launch"/);
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
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
  try {
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
    assert.ok(settled, 'launching a browser should start one on the browserfleet server and record its id');
    assert.equal(settled.data.status, 'running');
  } finally {
    restore();
  }
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
  const { restore } = stubFetchByRoute([REMOTEBROWSER_ROUTE]);
  try {
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
  } finally {
    restore();
  }
});

// Disabled button is courtesy; server-side check stops over-limit submissions.
test('POST /browsers/launch refuses a submission once the workspace is at capacity', async () => {
  const workspaceId = await makeUser();
  for (let i = 0; i < config.maxPersonalBrowsers; i += 1) {
    await launchBrowserInstance({
      workspaceId,
      userId,
      browserName: `browser-${i}`,
      browserDescription: ''
    });
  }
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
      workspace: workspaceId,
      csrf: makeCsrfToken(csrfId)
    }).toString()
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), new RegExp(`reached its limit of ${config.maxPersonalBrowsers} browsers`));
  const instances = await listBrowserInstancesByWorkspace({ workspaceId });
  assert.equal(instances.data.length, config.maxPersonalBrowsers, 'a rejected submission must write nothing more');
});
