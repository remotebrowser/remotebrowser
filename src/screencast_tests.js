import test from 'node:test';
import assert from 'node:assert/strict';
import { consola } from 'consola/basic';
import { WebSocketServer } from 'ws';

process.env.BROWSERFLEET_URL = 'http://browserfleet.test';

const { nextFrame, stopScreencasts, cache, SCREENCAST_OPTIONS } = await import('./screencast.js');

consola.level = -999;

const SEED = Buffer.from('seed frame');
const NEXT = Buffer.from('next frame');

const waitUntil = async (condition, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

// Records commands and lets a test push events.
const startBrowser = ({ pages = ['page1'] } = {}) =>
  new Promise((resolve) => {
    const calls = [];
    const sockets = [];
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (raw) => {
        const { id, method, params, sessionId } = JSON.parse(raw.toString());
        calls.push({ method, params, sessionId });
        const results = {
          'Target.getTargets': { targetInfos: pages.map((targetId) => ({ targetId, type: 'page' })) },
          'Target.attachToTarget': { sessionId: 'session1' },
          'Page.captureScreenshot': { data: SEED.toString('base64') }
        };
        socket.send(JSON.stringify({ id, sessionId, result: results[method] ?? {} }));
      });
    });
    wss.once('listening', () =>
      resolve({
        calls,
        sockets,
        cdpUrlFor: () => `ws://127.0.0.1:${wss.address().port}/cdp`,
        emit: (method, params, sessionId = 'session1') => {
          for (const socket of sockets) {
            socket.send(JSON.stringify({ method, params, sessionId }));
          }
        },
        // Stop screencasts first, so Page.stopScreencast still gets an answer.
        close: async () => {
          await stopScreencasts();
          await new Promise((done) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(done);
          });
        }
      })
    );
  });

test.afterEach(async () => stopScreencasts());

test('nextFrame seeds a JPEG frame and starts a screencast on the page', async () => {
  const browser = await startBrowser();
  try {
    const result = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    assert.deepEqual(result.data.data, SEED);
    assert.ok(result.data.seq > 0);
    const capture = browser.calls.find((call) => call.method === 'Page.captureScreenshot');
    assert.equal(capture.params.format, 'jpeg');
    assert.equal(capture.sessionId, 'session1');
    await waitUntil(() => browser.calls.some((call) => call.method === 'Page.startScreencast'));
    const start = browser.calls.find((call) => call.method === 'Page.startScreencast');
    assert.deepEqual(start.params, { ...SCREENCAST_OPTIONS });
    assert.equal(start.sessionId, 'session1');
  } finally {
    await browser.close();
  }
});

test('nextFrame waits for the next screencast frame and acks it', async () => {
  const browser = await startBrowser();
  try {
    const first = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    const pending = nextFrame({
      browserId: 'br-1',
      pageId: 'page1',
      after: first.data.seq,
      cdpUrlFor: browser.cdpUrlFor
    });
    await waitUntil(() => cache.screencasts.get('br-1:page1').waiters.size === 1);
    browser.emit('Page.screencastFrame', { data: NEXT.toString('base64'), sessionId: 7, metadata: {} });
    const second = await pending;
    assert.deepEqual(second.data.data, NEXT);
    assert.ok(second.data.seq > first.data.seq);
    assert.ok(await waitUntil(() => browser.calls.some((call) => call.method === 'Page.screencastFrameAck')));
    const ack = browser.calls.find((call) => call.method === 'Page.screencastFrameAck');
    assert.deepEqual(ack.params, { sessionId: 7 });
  } finally {
    await browser.close();
  }
});

test('nextFrame holds the ack until a reader takes a frame nobody was waiting for', async () => {
  const browser = await startBrowser();
  try {
    const first = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    browser.emit('Page.screencastFrame', { data: NEXT.toString('base64'), sessionId: 8, metadata: {} });
    await waitUntil(() => cache.screencasts.get('br-1:page1').frame.seq > first.data.seq);
    assert.equal(browser.calls.filter((call) => call.method === 'Page.screencastFrameAck').length, 0);
    const second = await nextFrame({
      browserId: 'br-1',
      pageId: 'page1',
      after: first.data.seq,
      cdpUrlFor: browser.cdpUrlFor
    });
    assert.deepEqual(second.data.data, NEXT);
    assert.ok(await waitUntil(() => browser.calls.some((call) => call.method === 'Page.screencastFrameAck')));
  } finally {
    await browser.close();
  }
});

test('nextFrame answers empty when the page does not repaint in time', async () => {
  const browser = await startBrowser();
  try {
    const first = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    const result = await nextFrame({
      browserId: 'br-1',
      pageId: 'page1',
      after: first.data.seq,
      timeout: 20,
      cdpUrlFor: browser.cdpUrlFor
    });
    assert.deepEqual(result, {});
  } finally {
    await browser.close();
  }
});

test('nextFrame stops waiting once the request is aborted', async () => {
  const browser = await startBrowser();
  try {
    const first = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    const controller = new AbortController();
    const pending = nextFrame({
      browserId: 'br-1',
      pageId: 'page1',
      after: first.data.seq,
      signal: controller.signal,
      cdpUrlFor: browser.cdpUrlFor
    });
    controller.abort();
    assert.deepEqual(await pending, {});
    assert.equal(cache.screencasts.get('br-1:page1').waiters.size, 0);
  } finally {
    await browser.close();
  }
});

test('nextFrame shares one screencast between readers of the same page', async () => {
  const browser = await startBrowser();
  try {
    await Promise.all([
      nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor }),
      nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor })
    ]);
    assert.equal(browser.sockets.length, 1);
  } finally {
    await browser.close();
  }
});

test('nextFrame reports NO_SUCH_PAGE for an unknown page and retries on the next read', async () => {
  const browser = await startBrowser({ pages: ['other'] });
  try {
    const result = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    assert.deepEqual(result, { error: 'NO_SUCH_PAGE' });
    assert.equal(cache.screencasts.size, 0);
  } finally {
    await browser.close();
  }
});

test('nextFrame wakes a waiting reader with NO_SUCH_PAGE when the tab closes', async () => {
  const browser = await startBrowser();
  try {
    const first = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    const pending = nextFrame({
      browserId: 'br-1',
      pageId: 'page1',
      after: first.data.seq,
      cdpUrlFor: browser.cdpUrlFor
    });
    await waitUntil(() => cache.screencasts.get('br-1:page1').waiters.size === 1);
    browser.emit('Target.detachedFromTarget', { sessionId: 'session1', targetId: 'page1' }, undefined);
    assert.deepEqual(await pending, { error: 'NO_SUCH_PAGE' });
    assert.equal(cache.screencasts.size, 0);
  } finally {
    await browser.close();
  }
});

test('stopScreencasts stops the screencast in Chrome before closing the socket', async () => {
  const browser = await startBrowser();
  try {
    await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    await waitUntil(() => cache.screencasts.get('br-1:page1').streaming);
    await stopScreencasts();
    const stop = browser.calls.find((call) => call.method === 'Page.stopScreencast');
    assert.equal(stop.sessionId, 'session1');
    assert.ok(await waitUntil(() => browser.sockets[0].readyState === browser.sockets[0].CLOSED));
    assert.equal(cache.screencasts.size, 0);
  } finally {
    await browser.close();
  }
});

test('a screencast nobody reads is stopped within a few seconds', async () => {
  const browser = await startBrowser();
  try {
    await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: browser.cdpUrlFor });
    assert.ok(await waitUntil(() => cache.screencasts.size === 0, 6000));
    assert.ok(await waitUntil(() => browser.calls.some((call) => call.method === 'Page.stopScreencast')));
    assert.ok(await waitUntil(() => browser.sockets[0].readyState === browser.sockets[0].CLOSED));
  } finally {
    await browser.close();
  }
});

test('nextFrame reports a browser without a CDP URL', async () => {
  const result = await nextFrame({ browserId: 'br-1', pageId: 'page1', cdpUrlFor: () => null });
  assert.deepEqual(result, { error: 'CDP_URL_UNAVAILABLE' });
});
