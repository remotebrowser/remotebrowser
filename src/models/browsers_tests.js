import test from 'node:test';
import assert from 'node:assert/strict';

const { describe } = test;

process.env.PGLITE_DATA_DIR = 'memory://';

const {
  launchBrowserInstance,
  recordProvisionedBrowser,
  updateBrowserInstanceStatus,
  transitionBrowserInstanceStatus,
  deleteBrowserInstance,
  listBrowserInstancesByWorkspace,
  listProvisionedBrowserInstances,
  getBrowserInstance,
  getBrowserInstanceByPublicId,
  setBrowserInstanceConfig,
  deleteOldBrowserLaunches,
  MAX_BROWSER_LAUNCHES_PER_MINUTE,
  browserIdForHandle
} = await import('./browsers.js');
const { findOrCreateUser } = await import('./users.js');
const { createWorkspace, deleteWorkspace, getCollaborator } = await import('./workspaces.js');
const { generateShortId } = await import('../id.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

// browser_instances FKs to both a workspace and its owning user.
const makeWorkspace = async () => {
  const owner = await findOrCreateUser({ email: 'owner1@example.com' });
  const ownerId = owner.data.id;
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  return { workspaceId: workspace.data.workspaceId, ownerId };
};

// The shape src/handle.js issues, checked by the schema too.
const HANDLE_PATTERN = /^H[23456789abcdefghijkmnpqrstuvwxyz]{36}$/;

test('launchBrowserInstance writes a starting instance and getBrowserInstance reads it back', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();

  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: 'For QA testing'
  });
  assert.equal(launched.error, undefined);
  assert.match(launched.data.publicId, /^B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  assert.equal(
    launched.data.publicId,
    (
      await getBrowserInstanceByPublicId({
        workspaceId,
        publicId: launched.data.publicId
      })
    ).data.publicId
  );

  const fetched = await getBrowserInstance({ workspaceId, browserInstanceId: launched.data.browserInstanceId });
  assert.equal(fetched.data.browserInstanceId, launched.data.browserInstanceId);
  assert.equal(fetched.data.publicId, launched.data.publicId);
  assert.equal(fetched.data.browserName, 'calm-otter');
  assert.equal(fetched.data.status, 'starting');
  assert.equal(fetched.data.internalBrowserId, '');
  assert.match(fetched.data.browserHandle, HANDLE_PATTERN);

  assert.deepEqual(await getBrowserInstance({ workspaceId, browserInstanceId: 999999 }), { data: null });
  assert.deepEqual(await getBrowserInstanceByPublicId({ workspaceId, publicId: 'Bzzzzzz' }), { data: null });
});

const browserPublicId = async (workspaceId, browserInstanceId) =>
  (await getBrowserInstance({ workspaceId, browserInstanceId })).data.publicId;

test('launchBrowserInstance assigns a friendly 6-character public id prefixed with B', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  assert.match(
    await browserPublicId(workspaceId, launched.data.browserInstanceId),
    /^B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/
  );
});

test('launchBrowserInstance regenerates the public id when the drawn one is taken', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const first = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'first',
    browserDescription: ''
  });
  const taken = await browserPublicId(workspaceId, first.data.browserInstanceId);

  let calls = 0;
  const generateId = () => (calls++ === 0 ? taken : generateShortId('B', 6));
  const second = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'second',
    browserDescription: '',
    generateId
  });

  assert.equal(second.error, undefined);
  assert.equal(calls, 2, 'the collision must trigger exactly one redraw');
  assert.notEqual(await browserPublicId(workspaceId, second.data.browserInstanceId), taken);
});

test('recordProvisionedBrowser records the internal id, and browserIdForHandle resolves the launch handle', async () => {
  // Mirrors src/routes/browsers/launch.js: the handle is issued with the row,
  // so the CDP relay resolves it from there once provisioning finishes.
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  const browserHandle = (await getBrowserInstance({ workspaceId, browserInstanceId })).data.browserHandle;

  const recorded = await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'internal-1',
    userId: ownerId
  });
  assert.deepEqual(recorded, { data: true });

  const fetched = await getBrowserInstance({ workspaceId, browserInstanceId });
  assert.equal(fetched.data.internalBrowserId, 'internal-1');
  assert.equal(fetched.data.browserHandle, browserHandle);
  assert.deepEqual(await browserIdForHandle({ handle: browserHandle }), { data: 'internal-1' });
});

test('recordProvisionedBrowser refuses an internal id that is not a safe path segment', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;

  for (const internalBrowserId of ['x/../../admin', '..', 'a.b', 'a%2f', '']) {
    const result = await recordProvisionedBrowser({
      workspaceId,
      browserInstanceId,
      internalBrowserId,
      userId: ownerId
    });
    assert.deepEqual(result, { error: 'INVALID_BROWSER_ID' }, `for ${JSON.stringify(internalBrowserId)}`);
  }

  // Nothing was written: the instance is still unprovisioned.
  assert.equal((await getBrowserInstance({ workspaceId, browserInstanceId })).data.internalBrowserId, '');
});

test('recordProvisionedBrowser is write-once: a second call cannot re-point an already-provisioned browser', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;

  const first = await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'internal-1',
    userId: ownerId
  });
  assert.deepEqual(first, { data: true });

  const second = await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'internal-2',
    userId: ownerId
  });
  assert.deepEqual(second, { error: 'ALREADY_PROVISIONED' });
  assert.equal((await getBrowserInstance({ workspaceId, browserInstanceId })).data.internalBrowserId, 'internal-1');
});

test('updateBrowserInstanceStatus and deleteBrowserInstance report whether a row existed', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;

  assert.deepEqual(await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: 'running' }), {
    data: true
  });
  assert.equal((await getBrowserInstance({ workspaceId, browserInstanceId })).data.status, 'running');

  assert.deepEqual(await updateBrowserInstanceStatus({ workspaceId, browserInstanceId: 999999, toStatus: 'running' }), {
    data: false
  });

  assert.deepEqual(await deleteBrowserInstance({ workspaceId, browserInstanceId }), { data: true });
  assert.deepEqual(await getBrowserInstance({ workspaceId, browserInstanceId }), { data: null });
});

test('listBrowserInstancesByWorkspace orders newest first', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const first = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'first',
    browserDescription: ''
  });
  const second = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'second',
    browserDescription: ''
  });

  const list = await listBrowserInstancesByWorkspace({ workspaceId });
  assert.deepEqual(
    list.data.map((instance) => instance.browserInstanceId),
    [second.data.browserInstanceId, first.data.browserInstanceId]
  );
});

test('listBrowserInstancesByWorkspace and getBrowserInstance repair a missing personal workspace first', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  // Simulate the personal workspace having been deleted out from under the user.
  await deleteWorkspace({ workspaceId });
  const repair = { userId: ownerId, email: 'owner1@example.com' };

  const list = await listBrowserInstancesByWorkspace({ workspaceId, personalWorkspaceRepair: repair });
  assert.deepEqual(list, { data: [] });
  // repairPersonalWorkspace recreates the workspace and seats the owner.
  assert.equal((await getCollaborator({ workspaceId, userId: ownerId })).data.role, 'Owner');
});

test('browserIdForHandle rejects malformed input and stops resolving a deleted browser', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  const browserInstanceId = launched.data.browserInstanceId;
  const browserHandle = (await getBrowserInstance({ workspaceId, browserInstanceId })).data.browserHandle;
  await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: 'internal-1',
    userId: ownerId
  });

  assert.deepEqual(await browserIdForHandle({ handle: 'nope' }), { data: null });
  assert.deepEqual(await browserIdForHandle({ handle: 'has/slash' }), { data: null });
  assert.deepEqual(await browserIdForHandle({ handle: '' }), { data: null });
  assert.deepEqual(await browserIdForHandle({ handle: null }), { data: null });

  // Deleting the instance removes the handle with it.
  assert.deepEqual(await deleteBrowserInstance({ workspaceId, browserInstanceId }), { data: true });
  assert.deepEqual(await browserIdForHandle({ handle: browserHandle }), { data: null });
});

test('listProvisionedBrowserInstances returns only browsers that have an internal id', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const provisioned = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'calm-otter',
    browserDescription: ''
  });
  await launchBrowserInstance({ workspaceId, userId: ownerId, browserName: 'still-starting', browserDescription: '' });
  await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId: provisioned.data.browserInstanceId,
    internalBrowserId: 'br-1',
    userId: ownerId
  });

  const listed = await listProvisionedBrowserInstances();
  assert.deepEqual(listed.data, [
    { workspaceId, browserInstanceId: provisioned.data.browserInstanceId, internalBrowserId: 'br-1' }
  ]);
});

const makeProvisionedBrowser = async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const launched = await launchBrowserInstance({ workspaceId, userId: ownerId, browserName: 'calm-otter' });
  const { browserInstanceId } = launched.data;
  await recordProvisionedBrowser({ workspaceId, browserInstanceId, internalBrowserId: 'Qabc12345', userId: ownerId });
  await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: 'running' });
  const status = async () => (await getBrowserInstance({ workspaceId, browserInstanceId })).data.status;
  return { workspaceId, browserInstanceId, status };
};

test('transitionBrowserInstanceStatus changes the status only from the given ones', async () => {
  const { workspaceId, browserInstanceId, status } = await makeProvisionedBrowser();
  const suspend = () =>
    transitionBrowserInstanceStatus({
      workspaceId,
      browserInstanceId,
      fromStatuses: ['running', 'error'],
      toStatus: 'suspended'
    });
  assert.deepEqual(await suspend(), { data: true });
  assert.equal(await status(), 'suspended');
  // A second, racing suspend finds nothing to change.
  assert.deepEqual(await suspend(), { data: false });
  assert.deepEqual(
    await transitionBrowserInstanceStatus({
      workspaceId,
      browserInstanceId,
      fromStatuses: ['suspended'],
      toStatus: 'running'
    }),
    { data: true }
  );
  assert.equal(await status(), 'running');
});

test('updateBrowserInstanceStatus leaves a suspended browser alone', async () => {
  const { workspaceId, browserInstanceId, status } = await makeProvisionedBrowser();
  await transitionBrowserInstanceStatus({
    workspaceId,
    browserInstanceId,
    fromStatuses: ['running'],
    toStatus: 'suspended'
  });
  // A monitor or a failed screenshot reporting the VM unreachable.
  assert.deepEqual(await updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus: 'error' }), {
    data: false
  });
  assert.equal(await status(), 'suspended');
});

test('listProvisionedBrowserInstances skips suspended browsers, which have nothing to monitor', async () => {
  const { workspaceId, browserInstanceId } = await makeProvisionedBrowser();
  assert.equal((await listProvisionedBrowserInstances()).data.length, 1);
  await transitionBrowserInstanceStatus({
    workspaceId,
    browserInstanceId,
    fromStatuses: ['running'],
    toStatus: 'suspended'
  });
  assert.deepEqual((await listProvisionedBrowserInstances()).data, []);
});

test('a browser starts with the config it was launched with, and setBrowserInstanceConfig replaces it', async () => {
  const { workspaceId, ownerId } = await makeWorkspace();
  const plain = await launchBrowserInstance({ workspaceId, userId: ownerId, browserName: 'plain' });
  assert.deepEqual(
    (await getBrowserInstance({ workspaceId, browserInstanceId: plain.data.browserInstanceId })).data.config,
    {}
  );

  const launched = await launchBrowserInstance({
    workspaceId,
    userId: ownerId,
    browserName: 'proxied',
    config: { proxy: 'socks5://proxy.example.com:1080' }
  });
  const { browserInstanceId } = launched.data;
  const config = async () => (await getBrowserInstance({ workspaceId, browserInstanceId })).data.config;
  assert.deepEqual(await config(), { proxy: 'socks5://proxy.example.com:1080' });

  assert.deepEqual(await setBrowserInstanceConfig({ workspaceId, browserInstanceId, config: { proxy: null } }), {
    data: true
  });
  assert.deepEqual(await config(), { proxy: null });
});

describe('launch rate', () => {
  const NOW = 1_700_000_000_000;
  const launch = (workspaceId, userId, { now = NOW } = {}) =>
    launchBrowserInstance({ workspaceId, userId, browserName: 'calm-otter', launchesPerMinute: 3, now });

  test('refuses a launch over the rate, and says when a slot frees up', async () => {
    const { workspaceId, ownerId } = await makeWorkspace();
    // 50 s, 30 s, and 10 s ago: all in the last minute.
    for (const ago of [50_000, 30_000, 10_000]) {
      assert.equal((await launch(workspaceId, ownerId, { now: NOW - ago })).error, undefined);
    }
    // The oldest leaves the window in 10 s.
    assert.deepEqual(await launch(workspaceId, ownerId), { error: 'LAUNCH_RATE_LIMITED', retryAfterSeconds: 10 });
    assert.equal((await launch(workspaceId, ownerId, { now: NOW + 10_000 })).error, undefined);
  });

  // Otherwise launching and terminating in a loop would get around the rate.
  test('still counts a launch whose browser was terminated', async () => {
    const { workspaceId, ownerId } = await makeWorkspace();
    for (let i = 0; i < 3; i += 1) {
      const launched = await launch(workspaceId, ownerId);
      await deleteBrowserInstance({ workspaceId, browserInstanceId: launched.data.browserInstanceId });
    }
    assert.equal((await launch(workspaceId, ownerId)).error, 'LAUNCH_RATE_LIMITED');
  });

  test('counts each workspace on its own', async () => {
    const { workspaceId, ownerId } = await makeWorkspace();
    const other = await createWorkspace({ name: 'Other', ownerId });
    for (let i = 0; i < 3; i += 1) {
      await launch(workspaceId, ownerId);
    }
    assert.equal((await launch(workspaceId, ownerId)).error, 'LAUNCH_RATE_LIMITED');
    assert.equal((await launch(other.data.workspaceId, ownerId)).error, undefined);
  });

  test('allows 120 launches a minute by default', () => {
    assert.equal(MAX_BROWSER_LAUNCHES_PER_MINUTE, 120);
  });

  test('deleteOldBrowserLaunches removes only launches older than the window', async () => {
    const { workspaceId, ownerId } = await makeWorkspace();
    await launch(workspaceId, ownerId, { now: NOW - 90_000 });
    await launch(workspaceId, ownerId, { now: NOW - 30_000 });
    assert.deepEqual(await deleteOldBrowserLaunches({ now: NOW }), { data: 1 });
    assert.deepEqual(await deleteOldBrowserLaunches({ now: NOW }), { data: 0 });
  });
});
