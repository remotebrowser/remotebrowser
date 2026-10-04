import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';
// No external fleet: the facade must drive the in-process container runtime.
process.env.BROWSERFLEET_URL = '';

const { setContainerClient } = await import('./container.js');
const { startBrowser, checkBrowserFleetHealth, browserExists, browserCdpUrl, stopBrowser, isWellFormedBrowserId } =
  await import('./fleet.js');

// A fake container client that records calls and can be told to fail. Swapped in
// for the real singleton so no container binary is needed here.
const fakeContainers = (overrides = {}) => {
  const calls = [];
  const record = (name, result) => async (args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result(args) : result;
  };
  const client = {
    launchBrowser: record('launchBrowser', { browserId: 'Pabc12345' }),
    browserIsRunning: record('browserIsRunning', true),
    browserExists: record('browserExists', true),
    stopBrowser: record('stopBrowser', undefined),
    resolveCdpUrl: record('resolveCdpUrl', 'ws://127.0.0.1:32768/devtools/browser/abc'),
    health: record('health', true),
    ...overrides
  };
  return { calls, client };
};

test('startBrowser launches a local container and returns its id', async () => {
  const { calls, client } = fakeContainers();
  setContainerClient(client);
  assert.deepEqual(await startBrowser(), { data: { browserId: 'Pabc12345' } });
  assert.equal(calls[0].name, 'launchBrowser');
});

test('startBrowser reports a failed container launch', async () => {
  setContainerClient(
    fakeContainers({
      launchBrowser: async () => {
        throw new Error('Unable to launch Google Chrome');
      }
    }).client
  );
  assert.deepEqual(await startBrowser(), { error: 'Unable to launch Google Chrome' });
});

test('checkBrowserFleetHealth probes the local container runtime', async () => {
  setContainerClient(fakeContainers().client);
  assert.deepEqual(await checkBrowserFleetHealth(), { data: { healthy: true } });

  setContainerClient(
    fakeContainers({
      health: async () => {
        throw new Error('container runtime is not available');
      }
    }).client
  );
  assert.deepEqual(await checkBrowserFleetHealth(), { error: 'container runtime is not available' });
});

test('browserExists checks the local container state', async () => {
  const live = fakeContainers();
  setContainerClient(live.client);
  assert.deepEqual(await browserExists({ browserId: 'Pabc12345' }), { data: true });
  assert.equal(live.calls[0].name, 'browserIsRunning');

  setContainerClient(fakeContainers({ browserIsRunning: async () => false }).client);
  assert.deepEqual(await browserExists({ browserId: 'Pabc12345' }), { data: false });

  setContainerClient(
    fakeContainers({
      browserIsRunning: async () => {
        throw new Error('runtime exploded');
      }
    }).client
  );
  assert.deepEqual(await browserExists({ browserId: 'Pabc12345' }), { error: 'runtime exploded' });
});

test('browserExists refuses a malformed id without touching the runtime', async () => {
  const { calls, client } = fakeContainers();
  setContainerClient(client);
  assert.deepEqual(await browserExists({ browserId: 'a/../b' }), { data: false });
  assert.equal(calls.length, 0);
});

test('stopBrowser removes the container, and a container already gone is success', async () => {
  const present = fakeContainers();
  setContainerClient(present.client);
  assert.deepEqual(await stopBrowser({ browserId: 'Pabc12345' }), { data: true });
  assert.deepEqual(
    present.calls.map((call) => call.name),
    ['browserExists', 'stopBrowser']
  );

  const gone = fakeContainers({ browserExists: async () => false });
  setContainerClient(gone.client);
  assert.deepEqual(await stopBrowser({ browserId: 'Pabc12345' }), { data: true });
  assert.equal(
    gone.calls.some((call) => call.name === 'stopBrowser'),
    false
  );
});

test('stopBrowser treats an empty id as a no-op and a malformed one as corruption', async () => {
  const { calls, client } = fakeContainers();
  setContainerClient(client);
  assert.deepEqual(await stopBrowser({ browserId: '' }), { data: true });
  assert.deepEqual(await stopBrowser({ browserId: 'a/../b' }), { error: 'INVALID_BROWSER_ID' });
  assert.equal(calls.length, 0);
});

test('stopBrowser reports a failed kill', async () => {
  setContainerClient(
    fakeContainers({
      stopBrowser: async () => {
        throw new Error('Unable to kill container');
      }
    }).client
  );
  assert.deepEqual(await stopBrowser({ browserId: 'Pabc12345' }), { error: 'Unable to kill container' });
});

test('browserCdpUrl resolves the local container CDP URL and null when it cannot', async () => {
  setContainerClient(fakeContainers().client);
  assert.equal(await browserCdpUrl({ browserId: 'Pabc12345' }), 'ws://127.0.0.1:32768/devtools/browser/abc');

  setContainerClient(fakeContainers({ resolveCdpUrl: async () => null }).client);
  assert.equal(await browserCdpUrl({ browserId: 'Pabc12345' }), null);

  setContainerClient(
    fakeContainers({
      resolveCdpUrl: async () => {
        throw new Error('not up');
      }
    }).client
  );
  assert.equal(await browserCdpUrl({ browserId: 'Pabc12345' }), null);
});

test('isWellFormedBrowserId is re-exported from the facade', () => {
  assert.equal(isWellFormedBrowserId('Pabc12345'), true);
  assert.equal(isWellFormedBrowserId('a/../b'), false);
});
