import test from 'node:test';
import assert from 'node:assert/strict';

const { setVmClient } = await import('./vm/index.js');
const { getScreen, stopScreens, cache } = await import('./screens.js');

const FRAME_A = Buffer.from('frame a');
const FRAME_B = Buffer.from('frame b');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake VM client that records what is saved, and serves `saved` as the
// frame from an earlier run.
const setup = ({ saved = null, frames = [] } = {}) => {
  const writes = [];
  setVmClient({
    saveScreenshot: async (browserId, pageId, jpeg) => writes.push({ browserId, pageId, jpeg }),
    readSavedScreenshot: async () => saved
  });
  let calls = 0;
  cache.capture = async () => {
    const frame = frames[Math.min(calls, frames.length - 1)] ?? null;
    calls += 1;
    return frame;
  };
  cache.interval = 5;
  cache.idle = 1000;
  return { writes, calls: () => calls };
};

test.afterEach(stopScreens);

test('getScreen waits for the first capture when nothing is saved, and saves it', async () => {
  const { writes } = setup({ frames: [FRAME_A] });
  const frame = await getScreen('br-1');
  assert.deepEqual(frame?.data, FRAME_A);
  assert.deepEqual(writes, [{ browserId: 'br-1', pageId: 'screen', jpeg: FRAME_A }]);
});

test('getScreen serves a saved frame at once, then the captured one', async () => {
  const saved = { data: FRAME_A, timestamp: 1 };
  setup({ saved, frames: [FRAME_B] });
  cache.capture = () => new Promise((resolve) => setTimeout(() => resolve(FRAME_B), 20));
  assert.equal(await getScreen('br-1'), saved);
  await wait(40);
  assert.deepEqual((await getScreen('br-1'))?.data, FRAME_B);
});

test('a failed capture keeps the last good frame', async () => {
  setup({ frames: [FRAME_A, null] });
  assert.deepEqual((await getScreen('br-1'))?.data, FRAME_A);
  await wait(30);
  assert.deepEqual((await getScreen('br-1'))?.data, FRAME_A);
});

test('capture repeats in the background and stops when nobody reads', async () => {
  const { calls } = setup({ frames: [FRAME_A] });
  cache.idle = 30;
  await getScreen('br-1');
  await wait(20);
  assert.ok(calls() > 1);
  await wait(80);
  assert.equal(cache.screens.has('br-1'), false);
  const stopped = calls();
  await wait(30);
  assert.equal(calls(), stopped);
});
