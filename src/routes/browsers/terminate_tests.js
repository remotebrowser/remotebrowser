import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Set before ./terminate pulls in ../../config, which freezes what it read.
process.env.BROWSERFLEET_URL = process.env.BROWSERFLEET_URL || 'http://browserfleet.test';
process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../../auth/signing.js');
const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./terminate.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const { launchBrowserInstance, recordProvisionedBrowser, getBrowserInstance, browserIdForHandle } =
  await import('../../models/browsers.js');
const { browserMonitors } = await import('../../browser.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

// Stands in for what secureHeaders sets before the route runs in production.
const TEST_SCRIPT_NONCE = 'test-nonce-value';

const setupApp = () => {
  const app = new Hono();
  app.use((c, next) => {
    c.set('secureHeadersNonce', TEST_SCRIPT_NONCE);
    return next();
  });
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
  const workspace = await ensurePersonalWorkspace({
    userId,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  return workspace.data.workspaceId;
};

// Seeds a fully-provisioned, running browser (internal id recorded; the handle
// is issued with the row at launch).
const makeRunningBrowser = async (workspaceId, { browserName = 'calm-otter', internalBrowserId = 'br-1' } = {}) => {
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName,
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  const handle = (await getBrowserInstance({ workspaceId, browserInstanceId })).data.browserHandle;
  await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId, userId });
  return { browserInstanceId, publicId: launched.data.publicId, handle, internalBrowserId };
};

const cookieFor = (activeWorkspaceId) => makeSessionCookie({ activeWorkspaceId: activeWorkspaceId });

// A shared workspace where the signed-in user holds `role`; the browser belongs
// to a different user, so only an Admin/Owner may terminate it.
const makeForeignBrowserInSharedWorkspace = async ({ role }) => {
  const owner = await findOrCreateUser({ email: 'owner@example.com' });
  const creator = await findOrCreateUser({ email: 'creator@example.com' });
  const workspace = await createWorkspace({ name: 'Acme Corp', ownerId: owner.data.id });
  const workspaceId = workspace.data.workspaceId;
  await createCollaborator({ workspaceId, userId, email: 'user@example.com', role, workspaceName: 'Acme Corp' });
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: creator.data.id,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'br-1',
    userId: creator.data.id
  });
  return { workspaceId, browserInstanceId, publicId: launched.data.publicId };
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

// The real, unrelated BrowserFleet HTTP API that actually stops the browser.
// No trailing slash issues here since stopBrowser always appends the id.
const FLEET_STOP_ROUTE = { match: /\/api\/v1\/browsers\//, responses: [() => new Response(null, { status: 204 })] };

const postTerminate = (
  app,
  workspaceId,
  publicId,
  { name, csrfId = 'a'.repeat(32), workspace = workspaceId, activeWorkspaceId = undefined }
) =>
  app.request(`/browsers/${publicId}/terminate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': `session=${cookieFor(activeWorkspaceId)}; csrf_id=${csrfId}`
    },
    body: new URLSearchParams({ name, workspace, csrf: makeCsrfToken(csrfId) }).toString()
  });

test('GET /browsers/:browserId/terminate redirects an unauthenticated visitor to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/browsers/999997/terminate');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

test('GET /browsers/:browserId/terminate warns that termination is permanent and asks for the browser name', async () => {
  const workspaceId = await makeUser();
  const { publicId } = await makeRunningBrowser(workspaceId);
  const app = setupApp();
  const res = await app.request(`/browsers/${publicId}/terminate`, {
    headers: { cookie: `session=${cookieFor()}` }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /permanent and cannot be undone/i);
  assert.match(body, new RegExp(`action="/browsers/${publicId}/terminate"`));
  assert.match(body, /name="name"/);
  assert.match(body, new RegExp(`name="workspace" value="${workspaceId}"`));
  assert.match(body, /Confirm browser name/);
  assert.match(body, /calm-otter/);
  assert.match(body, /class="btn-danger"[^>]*>Terminate</);
  assert.match(body, new RegExp(`href="/browsers/${publicId}" class="btn-secondary">Cancel`));
  // Enabled in markup (works without JS); disabled only by nonce'd script.
  assert.doesNotMatch(body, /id="terminate-button"[^>]*disabled/);
  assert.match(body, /data-confirm-name="calm-otter"/);
  assert.match(body, /<script nonce="test-nonce-value">[\s\S]*terminateButton\.disabled[\s\S]*<\/script>/);
  // calm-otter > Browsers > calm-otter... breadcrumb continues the browsers trail.
  assert.match(body, /href="\/browsers">Browsers/);
  assert.match(body, /aria-current="page">\s*calm-otter/);
});

test('GET /browsers/:browserId/terminate 404s for a browser that does not exist', async () => {
  await makeUser();
  const app = setupApp();
  const res = await app.request('/browsers/999998/terminate', { headers: { cookie: `session=${cookieFor()}` } });
  assert.equal(res.status, 404);
});

test('POST /browsers/:browserId/terminate rejects a missing or invalid CSRF token', async () => {
  const workspaceId = await makeUser();
  const { browserInstanceId, publicId } = await makeRunningBrowser(workspaceId);
  const { restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const app = setupApp();
    const res = await app.request(`/browsers/${publicId}/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `session=${cookieFor()}` },
      body: new URLSearchParams({ name: 'calm-otter', workspace: workspaceId, csrf: 'bogus' }).toString()
    });
    assert.equal(res.status, 403);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data.status, 'starting', 'the browser must not be terminated');
  } finally {
    restore();
  }
});

test('POST /browsers/:browserId/terminate keeps the browser when the typed name does not match', async () => {
  const workspaceId = await makeUser();
  const { browserInstanceId, publicId } = await makeRunningBrowser(workspaceId);
  const { restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, { name: 'wrong-name' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /does not match/i);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.ok(fetched.data, 'the browser must still exist');
  } finally {
    restore();
  }
});

test('POST /browsers/:browserId/terminate refuses a submission for a workspace the visitor switched away from', async () => {
  const workspaceId = await makeUser();
  const { browserInstanceId, publicId } = await makeRunningBrowser(workspaceId);
  const { restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, {
      name: 'calm-otter',
      workspace: 2222
    });
    assert.equal(res.status, 409);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.ok(fetched.data, 'the browser must still exist');
  } finally {
    restore();
  }
});

test('POST /browsers/:browserId/terminate stops the fleet browser, revokes the handle, deletes the instance, and redirects', async () => {
  const workspaceId = await makeUser();
  const { browserInstanceId, publicId, internalBrowserId, handle } = await makeRunningBrowser(workspaceId);
  const { calls, restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, { name: '  calm-otter  ' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/browsers');
    const fleetCall = calls.find(
      (c) => c.opts.method === 'DELETE' && new RegExp(`/api/v1/browsers/${internalBrowserId}$`).test(c.url)
    );
    assert.ok(fleetCall, 'the fleet must be asked to stop the internal browser id');

    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data, null, 'the instance record must be deleted');
    const resolved = await browserIdForHandle({ handle });
    assert.equal(resolved.data, null, 'the public handle must be revoked');
  } finally {
    restore();
  }
});

// Spies on the registry for one test; the real one would spawn workers.
const spyOnMonitorStop = (events) => {
  const original = browserMonitors.stopBrowserMonitor;
  browserMonitors.stopBrowserMonitor = async ({ internalBrowserId }) => {
    events.push(`monitor-stop:${internalBrowserId}`);
    return { data: true };
  };
  return () => {
    browserMonitors.stopBrowserMonitor = original;
  };
};

test('POST /browsers/:browserId/terminate stops the monitor only after the fleet stopped the browser', async () => {
  const workspaceId = await makeUser();
  const { publicId, internalBrowserId } = await makeRunningBrowser(workspaceId);
  const events = [];
  const restoreMonitor = spyOnMonitorStop(events);
  const { restore } = stubFetchByRoute([
    {
      match: /\/api\/v1\/browsers\//,
      responses: [
        () => {
          events.push('fleet-stop');
          return new Response(null, { status: 204 });
        }
      ]
    }
  ]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, { name: 'calm-otter' });
    assert.equal(res.status, 303);
    assert.deepEqual(events, ['fleet-stop', `monitor-stop:${internalBrowserId}`]);
  } finally {
    restore();
    restoreMonitor();
  }
});

test('POST /browsers/:browserId/terminate keeps the monitor when the fleet fails to stop the browser', async () => {
  const workspaceId = await makeUser();
  const { browserInstanceId, publicId } = await makeRunningBrowser(workspaceId);
  const events = [];
  const restoreMonitor = spyOnMonitorStop(events);
  const { restore } = stubFetchByRoute([
    { match: /\/api\/v1\/browsers\//, responses: [() => new Response(null, { status: 500 })] }
  ]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, { name: 'calm-otter' });
    assert.equal(res.status, 400);
    assert.deepEqual(events, [], 'a still-running browser keeps its monitor');
    assert.ok((await getBrowserInstance({ workspaceId, browserInstanceId })).data, 'the instance is kept');
  } finally {
    restore();
    restoreMonitor();
  }
});

// A 'starting' browser has no fleet id to stop; just clean up the row.
test('POST /browsers/:browserId/terminate terminates a browser that never finished provisioning', async () => {
  const workspaceId = await makeUser();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  const { calls, restore } = stubFetchByRoute([]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, launched.data.publicId, { name: 'calm-otter' });
    assert.equal(res.status, 303);
    assert.equal(calls.length, 0, 'nothing to stop on the fleet, and no handle to revoke');
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data, null);
  } finally {
    restore();
  }
});

test('GET /browsers/:browserId/terminate forbids a User from a browser they did not create', async () => {
  await makeUser();
  const { workspaceId, publicId } = await makeForeignBrowserInSharedWorkspace({ role: 'User' });
  const app = setupApp();
  const res = await app.request(`/browsers/${publicId}/terminate`, {
    headers: { cookie: `session=${cookieFor(workspaceId)}` }
  });
  assert.equal(res.status, 403);
});

test('POST /browsers/:browserId/terminate forbids a User from terminating a browser they did not create', async () => {
  await makeUser();
  const { workspaceId, browserInstanceId, publicId } = await makeForeignBrowserInSharedWorkspace({ role: 'User' });
  const { calls, restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, {
      name: 'calm-otter',
      activeWorkspaceId: workspaceId
    });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, 'the fleet must not be asked to stop the browser');
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.ok(fetched.data, 'the browser must still exist');
  } finally {
    restore();
  }
});

test('POST /browsers/:browserId/terminate lets an Admin terminate a browser they did not create', async () => {
  await makeUser();
  const { workspaceId, browserInstanceId, publicId } = await makeForeignBrowserInSharedWorkspace({ role: 'Admin' });
  const { restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, {
      name: 'calm-otter',
      activeWorkspaceId: workspaceId
    });
    assert.equal(res.status, 303);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data, null, 'an Admin may terminate any browser');
  } finally {
    restore();
  }
});

test('POST /browsers/:browserId/terminate lets an Owner terminate a browser they did not create', async () => {
  await makeUser();
  const { workspaceId, browserInstanceId, publicId } = await makeForeignBrowserInSharedWorkspace({ role: 'Owner' });
  const { restore } = stubFetchByRoute([FLEET_STOP_ROUTE]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, {
      name: 'calm-otter',
      activeWorkspaceId: workspaceId
    });
    assert.equal(res.status, 303);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.equal(fetched.data, null, 'an Owner may terminate any browser');
  } finally {
    restore();
  }
});

test('POST /browsers/:browserId/terminate leaves the browser untouched when the fleet stop fails', async () => {
  const workspaceId = await makeUser();
  const { browserInstanceId, publicId, internalBrowserId, handle } = await makeRunningBrowser(workspaceId);
  const { restore } = stubFetchByRoute([
    { match: /\/api\/v1\/browsers\//, responses: [() => new Response(null, { status: 500 })] }
  ]);
  try {
    const res = await postTerminate(setupApp(), workspaceId, publicId, { name: 'calm-otter' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /unable to terminate/i);
    const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
    assert.ok(fetched.data, 'the instance record must not be deleted');
    const resolved = await browserIdForHandle({ handle });
    assert.equal(resolved.data, internalBrowserId, 'the handle must not be revoked');
  } finally {
    restore();
  }
});
