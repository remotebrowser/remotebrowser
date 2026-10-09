import test from 'node:test';
import assert from 'node:assert/strict';

const { countActiveBrowsers, browserLimitFor, describeBrowserCapacity, nextBrowserStatus, createBrowserMonitors } =
  await import('./browser.js');
const { config } = await import('./config.js');
const { consola } = await import('consola/basic');
consola.level = -999;

test('countActiveBrowsers counts every non-terminated status', () => {
  const instances = [{ status: 'starting' }, { status: 'running' }, { status: 'error' }, { status: 'terminated' }];
  assert.equal(countActiveBrowsers(instances), 3);
});

test('countActiveBrowsers is 0 for an empty or all-terminated list', () => {
  assert.equal(countActiveBrowsers([]), 0);
  assert.equal(countActiveBrowsers([{ status: 'terminated' }, { status: 'terminated' }]), 0);
});

test('browserLimitFor picks the personal limit for a personal workspace', () => {
  assert.equal(browserLimitFor({ isPersonal: true }), config.maxPersonalBrowsers);
});

test('browserLimitFor picks the team limit for a shared workspace', () => {
  assert.equal(browserLimitFor({ isPersonal: false }), config.maxTeamBrowsers);
});

test('describeBrowserCapacity reports not at capacity while under the limit', () => {
  const workspace = { isPersonal: true };
  const instances = Array.from({ length: config.maxPersonalBrowsers - 1 }, () => ({ status: 'running' }));
  const capacity = describeBrowserCapacity({ workspace, instances });
  assert.equal(capacity.used, config.maxPersonalBrowsers - 1);
  assert.equal(capacity.limit, config.maxPersonalBrowsers);
  assert.equal(capacity.atCapacity, false);
});

test('describeBrowserCapacity reports at capacity once used reaches the limit', () => {
  const workspace = { isPersonal: true };
  const instances = Array.from({ length: config.maxPersonalBrowsers }, () => ({ status: 'running' }));
  const capacity = describeBrowserCapacity({ workspace, instances });
  assert.equal(capacity.atCapacity, true);
});

test('describeBrowserCapacity ignores terminated instances when checking capacity', () => {
  const workspace = { isPersonal: true };
  const instances = Array.from({ length: config.maxPersonalBrowsers }, () => ({ status: 'terminated' }));
  const capacity = describeBrowserCapacity({ workspace, instances });
  assert.equal(capacity.used, 0);
  assert.equal(capacity.atCapacity, false);
});

test('describeBrowserCapacity uses the team limit for a shared workspace', () => {
  const workspace = { isPersonal: false };
  const capacity = describeBrowserCapacity({ workspace, instances: [] });
  assert.equal(capacity.limit, config.maxTeamBrowsers);
});

test('nextBrowserStatus moves starting to running once the CDP connection succeeds', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'starting', cdpConnected: true }), 'running');
});

test('nextBrowserStatus leaves a not-yet-provisioned starting instance alone on failure', () => {
  // A freshly launched browser has no CDP endpoint to dial yet - failing here
  // just means "still starting", not "dead".
  assert.equal(nextBrowserStatus({ currentStatus: 'starting', cdpConnected: false }), null);
});

// null, not 'running': the value would not actually change. Returning null
// here is what tells the caller to skip the write entirely instead of writing
// the same status on every healthy poll.
test('nextBrowserStatus makes no write when a running instance is still healthy', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'running', cdpConnected: true }), null);
});

test('nextBrowserStatus demotes running to error once the CDP connection fails', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'running', cdpConnected: false }), 'error');
});

test('nextBrowserStatus recovers an error instance back to running if it answers again', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'error', cdpConnected: true }), 'running');
});

test('nextBrowserStatus gives up on an error instance that still cannot be reached', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'error', cdpConnected: false }), 'terminated');
});

test('nextBrowserStatus never revives a terminated instance', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'terminated', cdpConnected: true }), null);
  assert.equal(nextBrowserStatus({ currentStatus: 'terminated', cdpConnected: false }), null);
});

const waitFor = async (predicate, { timeoutMs = 2000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

// A fake worker per spawn; tests drive its callbacks by hand.
const setup = (overrides = {}) => {
  const spawned = [];
  const statuses = [];
  const registry = createBrowserMonitors({
    createMonitor: (options) => {
      const fake = { ...options, stopped: false, stop: async () => void (fake.stopped = true) };
      spawned.push(fake);
      return fake;
    },
    cdpUrlFor: async () => 'ws://cdp',
    exists: async () => ({ data: true }),
    setStatus: ({ state }) => statuses.push(state),
    backoff: 5,
    maxBackoff: 10,
    maxRestarts: 3,
    ...overrides
  });
  return { registry, spawned, statuses };
};

const monitoredBrowser = { workspaceId: 1, browserInstanceId: 2, internalBrowserId: 'br-1' };

test('start is idempotent and spawns one worker per browser', async () => {
  const { registry, spawned } = setup();
  assert.deepEqual(await registry.startBrowserMonitor(monitoredBrowser), { data: true });
  assert.deepEqual(await registry.startBrowserMonitor(monitoredBrowser), { data: true });
  assert.equal(spawned.length, 1);
  assert.equal(registry.monitoredCount(), 1);
});

test('start rejects a bad id and an unresolvable CDP URL, releasing the slot', async () => {
  const { registry, spawned } = setup({ cdpUrlFor: async () => null });
  assert.deepEqual(await registry.startBrowserMonitor({ ...monitoredBrowser, internalBrowserId: '' }), {
    error: 'INVALID_BROWSER_ID'
  });
  assert.deepEqual(await registry.startBrowserMonitor(monitoredBrowser), { error: 'CDP_URL_UNAVAILABLE' });
  assert.equal(registry.isMonitored('br-1'), false);
  assert.equal(spawned.length, 0);
});

test('start releases the slot when the CDP URL lookup throws', async () => {
  const { registry } = setup({
    cdpUrlFor: async () => {
      throw new Error('boom');
    }
  });
  assert.deepEqual(await registry.startBrowserMonitor(monitoredBrowser), { error: 'CDP_URL_UNAVAILABLE' });
  assert.equal(registry.isMonitored('br-1'), false);
});

test('a stop during the CDP URL lookup does not spawn a worker', async () => {
  let release;
  const { registry, spawned } = setup({ cdpUrlFor: () => new Promise((resolve) => (release = resolve)) });
  const starting = registry.startBrowserMonitor(monitoredBrowser);
  await registry.stopBrowserMonitor({ internalBrowserId: 'br-1' });
  release('ws://cdp');
  assert.deepEqual(await starting, { data: false });
  assert.equal(spawned.length, 0);
});

test('status messages are written, but not after the monitor is stopped', async () => {
  const { registry, spawned, statuses } = setup();
  await registry.startBrowserMonitor(monitoredBrowser);
  spawned[0].onStatus({ state: 'ready' });
  assert.deepEqual(statuses, ['ready']);
  await registry.stopBrowserMonitor({ internalBrowserId: 'br-1' });
  assert.equal(spawned[0].stopped, true);
  spawned[0].onStatus({ state: 'disconnected' });
  assert.deepEqual(statuses, ['ready']);
});

test('a crashed worker is restarted while the browser still exists', async () => {
  const { registry, spawned } = setup();
  await registry.startBrowserMonitor(monitoredBrowser);
  spawned[0].onExit();
  assert.ok(await waitFor(() => spawned.length === 2));
  assert.equal(registry.isMonitored('br-1'), true);
});

test('a failed existence check keeps the worker restarting', async () => {
  const { registry, spawned } = setup({ exists: async () => ({ error: 'NETWORK' }) });
  await registry.startBrowserMonitor(monitoredBrowser);
  spawned[0].onExit();
  assert.ok(await waitFor(() => spawned.length === 2));
  assert.equal(registry.isMonitored('br-1'), true);
});

test('a worker exit is final once the fleet confirms the browser is gone', async () => {
  const { registry, spawned } = setup({ exists: async () => ({ data: false }) });
  await registry.startBrowserMonitor(monitoredBrowser);
  spawned[0].onExit();
  assert.ok(await waitFor(() => !registry.isMonitored('br-1')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawned.length, 1);
});

test('the monitor gives up after the restart limit', async () => {
  const { registry, spawned } = setup();
  await registry.startBrowserMonitor(monitoredBrowser);
  // Each crash restarts until the 4th exceeds maxRestarts (3).
  for (let crash = 1; crash <= 3; crash += 1) {
    spawned.at(-1).onExit();
    assert.ok(await waitFor(() => spawned.length === crash + 1));
  }
  spawned.at(-1).onExit();
  assert.ok(await waitFor(() => !registry.isMonitored('br-1')));
  assert.equal(spawned.length, 4);
});

test('a ready worker resets the restart count', async () => {
  const { registry, spawned } = setup();
  await registry.startBrowserMonitor(monitoredBrowser);
  for (let crash = 1; crash <= 6; crash += 1) {
    spawned.at(-1).onStatus({ state: 'ready' });
    spawned.at(-1).onExit();
    assert.ok(await waitFor(() => spawned.length === crash + 1));
  }
  assert.equal(registry.isMonitored('br-1'), true);
});

test('a stop cancels a pending restart', async () => {
  const { registry, spawned } = setup({ backoff: 30, maxBackoff: 30 });
  await registry.startBrowserMonitor(monitoredBrowser);
  spawned[0].onExit();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await registry.stopBrowserMonitor({ internalBrowserId: 'br-1' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(spawned.length, 1);
});

test('stopAllBrowserMonitors stops every worker', async () => {
  const { registry, spawned } = setup();
  await registry.startBrowserMonitor(monitoredBrowser);
  await registry.startBrowserMonitor({ ...monitoredBrowser, internalBrowserId: 'br-2' });
  await registry.stopAllBrowserMonitors();
  assert.equal(registry.monitoredCount(), 0);
  assert.ok(spawned.every((fake) => fake.stopped));
});

test('startAllBrowserMonitors starts one worker per provisioned browser and skips unresolvable ones', async () => {
  const { registry, spawned } = setup({
    listBrowsers: async () => ({
      data: [
        { workspaceId: 1, browserInstanceId: 1, internalBrowserId: 'br-1' },
        { workspaceId: 1, browserInstanceId: 2, internalBrowserId: 'br-2' },
        { workspaceId: 2, browserInstanceId: 3, internalBrowserId: 'br-3' }
      ]
    }),
    cdpUrlFor: async ({ browserId }) => (browserId === 'br-2' ? null : 'ws://cdp')
  });
  assert.deepEqual(await registry.startAllBrowserMonitors(), { data: { started: 2, total: 3 } });
  assert.deepEqual(spawned.map((fake) => fake.internalBrowserId).sort(), ['br-1', 'br-3']);
  assert.equal(registry.isMonitored('br-2'), false);
});

test('startAllBrowserMonitors does not double-start a browser that is already monitored', async () => {
  const { registry, spawned } = setup({
    listBrowsers: async () => ({ data: [{ workspaceId: 1, browserInstanceId: 2, internalBrowserId: 'br-1' }] })
  });
  await registry.startBrowserMonitor(monitoredBrowser);
  await registry.startAllBrowserMonitors();
  assert.equal(spawned.length, 1);
});

test('startAllBrowserMonitors reports a failed listing', async () => {
  const { registry } = setup({ listBrowsers: async () => ({ error: 'DB_DOWN' }) });
  assert.deepEqual(await registry.startAllBrowserMonitors(), { error: 'DB_DOWN' });
});
