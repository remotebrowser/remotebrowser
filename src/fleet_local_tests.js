import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';
// No external fleet: the facade must drive the in-process QEMU VM manager.
process.env.BROWSERFLEET_URL = '';

const { setVmClient } = await import('./vm/index.js');
const {
  startBrowser,
  canStartBrowser,
  browserExists,
  browserCdpUrl,
  stopBrowser,
  isWellFormedBrowserId,
  canSuspendBrowsers,
  suspendBrowser,
  resumeBrowser,
  setBrowserProxy,
  clearBrowserProxy,
  setBrowserScreenResolution,
  setBrowserScreenScale,
  canSaveBrowserScreenshots,
  saveBrowserScreenshot
} = await import('./fleet.js');

// A fake VM client that records calls and can be told to fail. Swapped in
// for the real singleton so no QEMU is needed here.
const fakeVms = (overrides = {}) => {
  const calls = [];
  const record = (name, result) => async (args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result(args) : result;
  };
  const client = {
    canLaunchBrowser: record('canLaunchBrowser', true),
    launchBrowser: record('launchBrowser', { browserId: 'Pabc12345' }),
    browserIsRunning: record('browserIsRunning', true),
    browserExists: record('browserExists', true),
    stopBrowser: record('stopBrowser', undefined),
    suspendBrowser: record('suspendBrowser', undefined),
    resumeBrowser: record('resumeBrowser', { browserId: 'Pabc12345' }),
    resolveCdpUrl: record('resolveCdpUrl', 'ws://127.0.0.1:32768/devtools/browser/abc'),
    ...overrides
  };
  return { calls, client };
};

test('startBrowser launches a local VM and returns its id', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  assert.deepEqual(await startBrowser(), { data: { browserId: 'Pabc12345' } });
  assert.equal(calls[0].name, 'launchBrowser');
});

test('startBrowser passes the upstream proxy to the VM launch', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  await startBrowser({ proxy: 'http://proxy.example.com:8080' });
  assert.deepEqual(calls[0], {
    name: 'launchBrowser',
    args: { proxy: 'http://proxy.example.com:8080', screenResolution: null, screenScale: null }
  });
});

test('startBrowser passes the screen resolution to the VM launch', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  await startBrowser({ screenResolution: { width: 1280, height: 720 } });
  assert.deepEqual(calls[0], {
    name: 'launchBrowser',
    args: { proxy: null, screenResolution: { width: 1280, height: 720 }, screenScale: null }
  });
});

test('startBrowser passes the screen scale to the VM launch', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  await startBrowser({ screenScale: 150 });
  assert.deepEqual(calls[0], {
    name: 'launchBrowser',
    args: { proxy: null, screenResolution: null, screenScale: 150 }
  });
});

test('setBrowserScreenScale drives the local VM, and reports a failure or a malformed id', async () => {
  const calls = [];
  setVmClient(
    fakeVms({
      setScreenScale: async (browserId, screenScale) => {
        calls.push([browserId, screenScale]);
        if (!screenScale) throw new Error('unable to set the screen scale');
      }
    }).client
  );
  assert.deepEqual(await setBrowserScreenScale('Pabc12345', 200), { data: true });
  assert.deepEqual(await setBrowserScreenScale('Pabc12345', null), { error: 'unable to set the screen scale' });
  assert.deepEqual(await setBrowserScreenScale('../etc', null), { error: 'INVALID_BROWSER_ID' });
  assert.deepEqual(calls, [
    ['Pabc12345', 200],
    ['Pabc12345', null]
  ]);
});

test('setBrowserScreenResolution drives the local VM, and reports a failure or a malformed id', async () => {
  const calls = [];
  setVmClient(
    fakeVms({
      setScreenResolution: async (browserId, screenResolution) => {
        calls.push([browserId, screenResolution]);
        if (!screenResolution) throw new Error('the screen did not change');
      }
    }).client
  );
  assert.deepEqual(await setBrowserScreenResolution('Pabc12345', { width: 1280, height: 720 }), { data: true });
  assert.deepEqual(await setBrowserScreenResolution('Pabc12345', null), { error: 'the screen did not change' });
  assert.deepEqual(await setBrowserScreenResolution('../etc', null), { error: 'INVALID_BROWSER_ID' });
  assert.deepEqual(calls, [
    ['Pabc12345', { width: 1280, height: 720 }],
    ['Pabc12345', null]
  ]);
});

test('setBrowserProxy and clearBrowserProxy drive the local VM, and report a failure or a malformed id', async () => {
  const calls = [];
  setVmClient(
    fakeVms({
      setProxy: async (browserId, proxy) => {
        calls.push(['setProxy', browserId, proxy]);
        if (proxy === 'bad') throw new Error('The proxy URL is not a valid URL');
      },
      clearProxy: async (browserId) => {
        calls.push(['clearProxy', browserId]);
      }
    }).client
  );
  assert.deepEqual(await setBrowserProxy('Pabc12345', 'http://proxy.example.com:8080'), { data: true });
  assert.deepEqual(await setBrowserProxy('Pabc12345', 'bad'), { error: 'The proxy URL is not a valid URL' });
  assert.deepEqual(await clearBrowserProxy('Pabc12345'), { data: true });
  assert.deepEqual(await setBrowserProxy('../etc', 'http://proxy.example.com:8080'), { error: 'INVALID_BROWSER_ID' });
  assert.deepEqual(await clearBrowserProxy('../etc'), { error: 'INVALID_BROWSER_ID' });
  assert.deepEqual(calls, [
    ['setProxy', 'Pabc12345', 'http://proxy.example.com:8080'],
    ['setProxy', 'Pabc12345', 'bad'],
    ['clearProxy', 'Pabc12345']
  ]);
});

test('startBrowser reports a failed VM launch', async () => {
  setVmClient(
    fakeVms({
      launchBrowser: async () => {
        throw new Error('Unable to launch Chromium');
      }
    }).client
  );
  assert.deepEqual(await startBrowser(), { error: 'Unable to launch Chromium' });
});

test('canStartBrowser asks the local VM manager', async () => {
  setVmClient(fakeVms().client);
  assert.deepEqual(await canStartBrowser(), { data: true });
  setVmClient(fakeVms({ canLaunchBrowser: async () => false }).client);
  assert.deepEqual(await canStartBrowser(), { data: false });
  setVmClient(
    fakeVms({
      canLaunchBrowser: async () => {
        throw new Error('no accel');
      }
    }).client
  );
  assert.deepEqual(await canStartBrowser(), { error: 'no accel' });
});

test('browserExists checks the local VM state', async () => {
  const live = fakeVms();
  setVmClient(live.client);
  assert.deepEqual(await browserExists({ browserId: 'Pabc12345' }), { data: true });
  assert.equal(live.calls[0].name, 'browserIsRunning');

  setVmClient(fakeVms({ browserIsRunning: async () => false }).client);
  assert.deepEqual(await browserExists({ browserId: 'Pabc12345' }), { data: false });

  setVmClient(
    fakeVms({
      browserIsRunning: async () => {
        throw new Error('runtime exploded');
      }
    }).client
  );
  assert.deepEqual(await browserExists({ browserId: 'Pabc12345' }), { error: 'runtime exploded' });
});

test('browserExists refuses a malformed id without touching the runtime', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  assert.deepEqual(await browserExists({ browserId: 'a/../b' }), { data: false });
  assert.equal(calls.length, 0);
});

test('stopBrowser removes the VM, and a VM already gone is success', async () => {
  const present = fakeVms();
  setVmClient(present.client);
  assert.deepEqual(await stopBrowser({ browserId: 'Pabc12345' }), { data: true });
  assert.deepEqual(
    present.calls.map((call) => call.name),
    ['browserExists', 'stopBrowser']
  );

  const gone = fakeVms({ browserExists: async () => false });
  setVmClient(gone.client);
  assert.deepEqual(await stopBrowser({ browserId: 'Pabc12345' }), { data: true });
  assert.equal(
    gone.calls.some((call) => call.name === 'stopBrowser'),
    false
  );
});

test('stopBrowser treats an empty id as a no-op and a malformed one as corruption', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  assert.deepEqual(await stopBrowser({ browserId: '' }), { data: true });
  assert.deepEqual(await stopBrowser({ browserId: 'a/../b' }), { error: 'INVALID_BROWSER_ID' });
  assert.equal(calls.length, 0);
});

test('stopBrowser reports a failed kill', async () => {
  setVmClient(
    fakeVms({
      stopBrowser: async () => {
        throw new Error('Unable to stop VM');
      }
    }).client
  );
  assert.deepEqual(await stopBrowser({ browserId: 'Pabc12345' }), { error: 'Unable to stop VM' });
});

test('browserCdpUrl resolves the local VM CDP URL and null when it cannot', async () => {
  setVmClient(fakeVms().client);
  assert.equal(await browserCdpUrl({ browserId: 'Pabc12345' }), 'ws://127.0.0.1:32768/devtools/browser/abc');

  setVmClient(fakeVms({ resolveCdpUrl: async () => null }).client);
  assert.equal(await browserCdpUrl({ browserId: 'Pabc12345' }), null);

  setVmClient(
    fakeVms({
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

test('suspendBrowser and resumeBrowser drive the local VM', async () => {
  const { calls, client } = fakeVms();
  setVmClient(client);
  assert.equal(canSuspendBrowsers(), true);
  assert.deepEqual(await suspendBrowser({ browserId: 'Pabc12345' }), { data: true });
  assert.deepEqual(await resumeBrowser({ browserId: 'Pabc12345' }), { data: true });
  assert.deepEqual(
    calls.map(({ name, args }) => [name, args]),
    [
      ['suspendBrowser', 'Pabc12345'],
      ['resumeBrowser', 'Pabc12345']
    ]
  );
});

test('suspendBrowser and resumeBrowser report a failure, and refuse a malformed id', async () => {
  const { calls, client } = fakeVms({
    suspendBrowser: async () => {
      throw new Error('saving the VM state failed');
    },
    resumeBrowser: async () => {
      throw new Error('Unable to resume chromium-Pabc12345');
    }
  });
  setVmClient(client);
  assert.deepEqual(await suspendBrowser({ browserId: 'Pabc12345' }), { error: 'saving the VM state failed' });
  assert.deepEqual(await resumeBrowser({ browserId: 'Pabc12345' }), { error: 'Unable to resume chromium-Pabc12345' });
  assert.deepEqual(await suspendBrowser({ browserId: '../etc' }), { error: 'INVALID_BROWSER_ID' });
  assert.deepEqual(await resumeBrowser({ browserId: '' }), { error: 'INVALID_BROWSER_ID' });
  assert.equal(calls.length, 0);
});

test('saveBrowserScreenshot hands the frame to the local VM and ignores a failure or a malformed id', async () => {
  const jpeg = Buffer.from('jpeg');
  const { calls, client } = fakeVms({ saveScreenshot: async (...args) => void calls.push(args) });
  setVmClient(client);
  assert.equal(canSaveBrowserScreenshots(), true);
  await saveBrowserScreenshot({ browserId: 'Pabc12345', pageId: 'page1', jpeg });
  await saveBrowserScreenshot({ browserId: '../etc', pageId: 'page1', jpeg });
  assert.deepEqual(calls, [['Pabc12345', 'page1', jpeg]]);
  setVmClient(
    fakeVms({
      saveScreenshot: async () => {
        throw new Error('disk full');
      }
    }).client
  );
  await saveBrowserScreenshot({ browserId: 'Pabc12345', pageId: 'page1', jpeg });
});
