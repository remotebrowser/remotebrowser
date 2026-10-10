import test from 'node:test';
import assert from 'node:assert/strict';

// Pin a fleet origin so browserCdpUrl stays deterministic and no container is dialed.
process.env.BROWSERFLEET_URL = 'http://fleet.test';

const { getScreenshot, requestScreenshot, stopScreenshots, cleanupScreenshots, cache } =
  await import('./screenshots.js');
const { consola } = await import('consola/basic');

// Silence the module's capture-failure logs so the suite's output stays readable.
consola.level = -999;

const CDP_URL = 'ws://fleet.test/api/v1/browsers/br-1/cdp';

// Lets the fire-and-forget capture queued by getScreenshot settle.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Reset the shared cache per test with a fake pool whose `capture` echoes the page key.
const resetCache = ({ capture } = {}) => {
  const captureCalls = [];
  let poolClosed = false;
  const pool = {
    capture: async (task) => {
      captureCalls.push({ browserId: task.browserId, pageId: task.pageId, url: task.url });
      return capture ? capture(task) : { data: Buffer.from(`${task.browserId}:${task.pageId}`) };
    },
    close: async () => {
      poolClosed = true;
    }
  };
  cache.screenshots = new Map();
  cache.inFlight = new Map();
  cache.pool = pool;
  return { captureCalls, isPoolClosed: () => poolClosed };
};

test('getScreenshot returns null on a miss and queues a capture', async () => {
  const s = resetCache();
  assert.equal(getScreenshot('br-1', 'p1'), null, 'a miss is reported as null');
  await flush();
  assert.deepEqual(s.captureCalls, [{ browserId: 'br-1', pageId: 'p1', url: CDP_URL }]);
  const frame = getScreenshot('br-1', 'p1');
  assert.equal(frame.browserId, 'br-1');
  assert.equal(frame.pageId, 'p1');
  assert.equal(frame.data.toString(), 'br-1:p1');
  assert.ok(Number.isFinite(frame.timestamp));
});

test('getScreenshot serves a frame younger than the window without capturing', async () => {
  const s = resetCache();
  getScreenshot('br-1', 'p1');
  await flush();
  assert.equal(s.captureCalls.length, 1);
  assert.equal(getScreenshot('br-1', 'p1').data.toString(), 'br-1:p1', 'the fresh frame is served');
  await flush();
  assert.equal(s.captureCalls.length, 1, 'a frame inside the window must not refresh');
});

test('getScreenshot serves a stale frame and queues a refresh in the background', async () => {
  const s = resetCache();
  cache.screenshots.set('br-1:p1', {
    browserId: 'br-1',
    pageId: 'p1',
    data: Buffer.from('stale'),
    timestamp: Date.now() - 5000
  });
  assert.equal(getScreenshot('br-1', 'p1').data.toString(), 'stale', 'the stale frame is served as-is');
  await flush();
  assert.equal(s.captureCalls.length, 1, 'a stale read queues a fresh capture');
  assert.equal(getScreenshot('br-1', 'p1').data.toString(), 'br-1:p1', 'the refreshed frame is served next');
});

test('a failed capture is not cached, so a later read retries', async () => {
  let fail = true;
  const s = resetCache({
    capture: async () => (fail ? { error: 'NO_SUCH_PAGE' } : { data: Buffer.from('frame') })
  });
  assert.equal(getScreenshot('br-1', 'p1'), null);
  await flush();
  assert.equal(cache.screenshots.size, 0, 'a failed capture must not be cached');
  fail = false;
  assert.equal(getScreenshot('br-1', 'p1'), null, 'still nothing cached to serve');
  await flush();
  assert.equal(getScreenshot('br-1', 'p1').data.toString(), 'frame');
});

test('a throwing capture is logged, not cached', async () => {
  const messages = [];
  const original = consola.debug;
  consola.debug = (message) => messages.push(String(message));
  try {
    resetCache({
      capture: async () => {
        throw new Error('capture exploded');
      }
    });
    assert.equal(getScreenshot('br-1', 'p1'), null);
    await flush();
    assert.equal(cache.screenshots.size, 0);
    assert.match(messages.join('\n'), /capture exploded/);
  } finally {
    consola.debug = original;
  }
});

test('requestScreenshot does not queue a second worker while one is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const s = resetCache({
    capture: async () => {
      await gate;
      return { data: Buffer.from('frame') };
    }
  });
  const first = requestScreenshot('br-1', 'p1');
  const second = requestScreenshot('br-1', 'p1');
  assert.equal(second, first, 'the in-flight request is reused');
  await flush();
  assert.equal(s.captureCalls.length, 1, 'only one worker is fired while one is in flight');
  release();
  await first;
  requestScreenshot('br-1', 'p1');
  await flush();
  assert.equal(s.captureCalls.length, 2, 'a finished request lets a new one start');
});

test('getScreenshot does not stack workers when called again before the first finishes', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const s = resetCache({
    capture: async () => {
      await gate;
      return { data: Buffer.from('frame') };
    }
  });
  assert.equal(getScreenshot('br-1', 'p1'), null);
  assert.equal(getScreenshot('br-1', 'p1'), null);
  await flush();
  assert.equal(s.captureCalls.length, 1, 'the second call must not fire another worker');
  release();
  await flush();
  assert.equal(getScreenshot('br-1', 'p1').data.toString(), 'frame');
});

test('cleanupScreenshots drops frames idle past the inactive window, keeping the rest', () => {
  resetCache();
  const now = Date.now();
  const inactive = 10 * 60 * 1000;
  cache.screenshots.set('br-1:p1', {
    browserId: 'br-1',
    pageId: 'p1',
    data: Buffer.from('old'),
    timestamp: now - inactive - 1
  });
  cache.screenshots.set('br-1:p2', {
    browserId: 'br-1',
    pageId: 'p2',
    data: Buffer.from('fresh'),
    timestamp: now - inactive + 1
  });
  cleanupScreenshots(now);
  assert.deepEqual([...cache.screenshots.keys()], ['br-1:p2']);
});

test('cleanupScreenshots keeps a frame exactly at the inactive window', () => {
  resetCache();
  const now = Date.now();
  cache.screenshots.set('br-1:p1', {
    browserId: 'br-1',
    pageId: 'p1',
    data: Buffer.from('edge'),
    timestamp: now - 10 * 60 * 1000
  });
  cleanupScreenshots(now);
  assert.equal(cache.screenshots.size, 1);
});

test('a cleaned up page is captured again on the next read', async () => {
  const s = resetCache();
  cache.screenshots.set('br-1:p1', {
    browserId: 'br-1',
    pageId: 'p1',
    data: Buffer.from('old'),
    timestamp: Date.now() - 10 * 60 * 1000 - 1
  });
  cleanupScreenshots();
  assert.equal(getScreenshot('br-1', 'p1'), null);
  await flush();
  assert.equal(s.captureCalls.length, 1);
  assert.equal(getScreenshot('br-1', 'p1').data.toString(), 'br-1:p1');
});

test('stopScreenshots closes the pool once and drops the frames', async () => {
  const s = resetCache();
  getScreenshot('br-1', 'p1');
  await flush();
  assert.equal(cache.screenshots.size, 1);
  await stopScreenshots();
  assert.equal(s.isPoolClosed(), true);
  assert.equal(cache.screenshots.size, 0);
  assert.equal(cache.pool, null);
  await stopScreenshots();
  assert.equal(s.isPoolClosed(), true);
});

test('stopScreenshots is a no-op with no pool', async () => {
  resetCache();
  cache.pool = null;
  await stopScreenshots();
  assert.equal(cache.pool, null);
});

test('getScreenshot returns null for a page that was never captured', async () => {
  resetCache();
  assert.equal(getScreenshot('nope', 'nope'), null);
  await flush();
});

test('getScreenshot without a page id serves the first page once it is looked up', async () => {
  const s = resetCache();
  cache.firstPages = new Map();
  cache.resolving = new Set();
  cache.listPages = async () => ({ data: [{ targetId: 'p1' }, { targetId: 'p2' }] });
  assert.equal(getScreenshot('br-1'), null, 'the first page is unknown until looked up');
  await flush();
  assert.equal(getScreenshot('br-1'), null, 'the first read after lookup queues the capture');
  await flush();
  assert.deepEqual(s.captureCalls, [{ browserId: 'br-1', pageId: 'p1', url: CDP_URL }]);
  assert.equal(getScreenshot('br-1').data.toString(), 'br-1:p1');
});
