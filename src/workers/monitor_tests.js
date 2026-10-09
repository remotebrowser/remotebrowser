import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const { createBrowserMonitor } = await import('./monitor.js');
const { consola } = await import('consola/basic');
consola.level = -999;

// A minimal CDP endpoint: it answers discovery, then replays one page target
// and, once told, pushes later events to the connected client.
const startCdpStub = () =>
  new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const { id, method } = message;
        if (method === 'Target.setDiscoverTargets') {
          socket.send(JSON.stringify({ id, result: {} }));
          socket.send(
            JSON.stringify({
              method: 'Target.targetCreated',
              params: { targetInfo: { targetId: 'p1', type: 'page', url: 'https://example.com/' } }
            })
          );
        } else {
          socket.send(JSON.stringify({ id, error: { message: `unscripted method ${method}` } }));
        }
      });
    });
    wss.once('listening', () =>
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}/cdp`,
        push: (event) => {
          for (const client of wss.clients) {
            client.send(JSON.stringify(event));
          }
        },
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(done);
          })
      })
    );
  });

const waitFor = async (predicate, { timeoutMs = 3000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

test('a monitor reports page navigations and status over message passing', async () => {
  const stub = await startCdpStub();
  const navigations = [];
  const statuses = [];
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url,
    onNavigation: (navigation) => navigations.push(navigation),
    onStatus: (status) => statuses.push(status.state)
  });
  try {
    assert.ok(
      await waitFor(() => navigations.length > 0 && statuses.includes('ready')),
      'the navigation and the ready status both arrive'
    );
    assert.deepEqual(navigations[0], { pageId: 'p1', url: 'https://example.com/' });
  } finally {
    await monitor.stop();
    await stub.close();
  }
});

test('a monitor reports later URL changes once and ignores other targets', async () => {
  const stub = await startCdpStub();
  const navigations = [];
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url,
    onNavigation: (navigation) => navigations.push(navigation)
  });
  const changed = (targetInfo) => ({ method: 'Target.targetInfoChanged', params: { targetInfo } });
  try {
    assert.ok(await waitFor(() => navigations.length === 1));
    // A title-only change repeats the URL; a worker target is not a page.
    stub.push(changed({ targetId: 'p1', type: 'page', url: 'https://example.com/', title: 'Example' }));
    stub.push(changed({ targetId: 'w1', type: 'service_worker', url: 'https://example.com/sw.js' }));
    stub.push(changed({ targetId: 'p1', type: 'page', url: 'https://example.com/next' }));
    assert.ok(await waitFor(() => navigations.length === 2));
    assert.deepEqual(navigations[1], { pageId: 'p1', url: 'https://example.com/next' });
  } finally {
    await monitor.stop();
    await stub.close();
  }
});

test('about:blank is not reported as a navigation', async () => {
  const stub = await startCdpStub();
  const navigations = [];
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url,
    onNavigation: (navigation) => navigations.push(navigation)
  });
  const changed = (url) => ({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: 'p1', type: 'page', url } }
  });
  try {
    assert.ok(await waitFor(() => navigations.length === 1));
    stub.push(changed('about:blank'));
    stub.push({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'p2', type: 'page', url: 'about:blank' } }
    });
    stub.push(changed('https://example.com/after'));
    assert.ok(await waitFor(() => navigations.length === 2));
    assert.deepEqual(
      navigations.map((navigation) => navigation.url),
      ['https://example.com/', 'https://example.com/after']
    );
  } finally {
    await monitor.stop();
    await stub.close();
  }
});

test('a burst of URL changes on one page is coalesced to the latest URL', async () => {
  const stub = await startCdpStub();
  const navigations = [];
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url,
    onNavigation: (navigation) => navigations.push(navigation)
  });
  try {
    assert.ok(await waitFor(() => navigations.length === 1));
    for (let i = 0; i < 50; i += 1) {
      stub.push({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { targetId: 'p1', type: 'page', url: `https://example.com/${i}` } }
      });
    }
    assert.ok(await waitFor(() => navigations.at(-1).url === 'https://example.com/49'));
    assert.ok(navigations.length <= 3, `expected few reports, got ${navigations.length}`);
  } finally {
    await monitor.stop();
    await stub.close();
  }
});

test('a monitor reports a disconnect and exits when the browser connection drops', async () => {
  const stub = await startCdpStub();
  const statuses = [];
  let exited = false;
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url,
    onStatus: (status) => statuses.push(status.state),
    onExit: () => {
      exited = true;
    }
  });
  try {
    assert.ok(await waitFor(() => statuses.includes('ready')));
    await stub.close();
    assert.ok(await waitFor(() => statuses.includes('disconnected') && exited));
  } finally {
    await monitor.stop();
  }
});

test('stop() lets the worker exit on its own and is safe to call twice', async () => {
  const stub = await startCdpStub();
  const statuses = [];
  let exits = 0;
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url,
    onStatus: (status) => statuses.push(status.state),
    onExit: () => {
      exits += 1;
    }
  });
  try {
    assert.ok(await waitFor(() => statuses.includes('ready')));
    const started = Date.now();
    await Promise.all([monitor.stop(), monitor.stop()]);
    assert.ok(Date.now() - started < 1500, 'a graceful stop does not wait for the terminate fallback');
    assert.ok(await waitFor(() => exits === 1));
    // The socket closing because we asked must not count as a disconnect.
    assert.ok(!statuses.includes('disconnected'));
  } finally {
    await stub.close();
  }
});

test('stop() before the worker is connected still ends it', async () => {
  const stub = await startCdpStub();
  const monitor = createBrowserMonitor({
    internalBrowserId: 'br-1',
    cdpUrl: stub.url
  });
  try {
    await monitor.stop();
    await monitor.stop();
  } finally {
    await stub.close();
  }
});
