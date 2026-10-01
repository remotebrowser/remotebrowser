import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const {
  launchBrowserInstance,
  recordProvisionedBrowser,
  updateBrowserInstanceStatus,
  deleteBrowserInstance,
  listBrowserInstancesByWorkspace,
  getBrowserInstance,
  getBrowserInstanceByPublicId,
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

test('recordProvisionedBrowser refuses a fleet id that is not a safe path segment', async () => {
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
