import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';
// No external fleet: frames are saved in, and read back from, the local VM dir.
process.env.BROWSERFLEET_URL = '';

const { setVmClient } = await import('./vm/index.js');
const { getScreenshot, cache } = await import('./screenshots.js');
const { consola } = await import('consola/basic');

consola.level = -999;

const BROWSER_ID = 'Pabc12345';

// A capture that never ends, so only the disk can answer a miss.
const resetCache = () => {
  const captures = [];
  cache.screenshots = new Map();
  cache.inFlight = new Map();
  cache.pool = {
    capture: (task) => {
      captures.push(task.pageId);
      return new Promise(() => {});
    },
    close: async () => {}
  };
  return captures;
};

const savedVms = (saved) => ({
  resolveCdpUrl: async () => 'ws://127.0.0.1:1/devtools/browser/x',
  saveScreenshot: async () => {},
  readSavedScreenshot: async (browserId, pageId) => saved[`${browserId}:${pageId}`] ?? null
});

test('getScreenshot serves the frame saved on disk on a memory miss, and still queues a capture', async () => {
  const captures = resetCache();
  const timestamp = Date.now() - 60000;
  setVmClient(savedVms({ [`${BROWSER_ID}:PAGE1`]: { data: Buffer.from('saved'), timestamp } }));
  const frame = await getScreenshot(BROWSER_ID, 'PAGE1');
  assert.equal(frame.data.toString(), 'saved');
  // The file's time, so the old frame is refreshed like any stale one.
  assert.equal(frame.timestamp, timestamp);
  assert.equal(cache.screenshots.get(`${BROWSER_ID}:PAGE1`), frame, 'the next read comes from memory');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captures, ['PAGE1']);
});

test('getScreenshot is null when neither memory nor disk has the page', async () => {
  resetCache();
  setVmClient(savedVms({}));
  assert.equal(await getScreenshot(BROWSER_ID, 'PAGE1'), null);
  assert.equal(cache.screenshots.size, 0);
});

test('getScreenshot prefers a capture that lands while the disk is read', async () => {
  resetCache();
  const fresh = { browserId: BROWSER_ID, pageId: 'PAGE1', data: Buffer.from('fresh'), timestamp: Date.now() };
  setVmClient({
    ...savedVms({}),
    readSavedScreenshot: async () => {
      cache.screenshots.set(`${BROWSER_ID}:PAGE1`, fresh);
      return { data: Buffer.from('saved'), timestamp: 0 };
    }
  });
  assert.equal(await getScreenshot(BROWSER_ID, 'PAGE1'), fresh);
});
