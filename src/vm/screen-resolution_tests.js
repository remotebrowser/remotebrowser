import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCREEN_RESOLUTION,
  GUEST_SCREEN_RESOLUTION_FILE,
  normalizeScreenResolution,
  writeGuestScreenResolution
} from './screen-resolution.js';

test('normalizeScreenResolution takes a screen size', () => {
  assert.deepEqual(normalizeScreenResolution({ width: 1366, height: 768 }), { width: 1366, height: 768 });
  assert.deepEqual(normalizeScreenResolution({ width: 3840, height: 2160 }), { width: 3840, height: 2160 });
  assert.deepEqual(normalizeScreenResolution({ width: 640, height: 480 }), { width: 640, height: 480 });
  assert.deepEqual(normalizeScreenResolution(DEFAULT_SCREEN_RESOLUTION), DEFAULT_SCREEN_RESOLUTION);
});

test('normalizeScreenResolution treats nothing as the default', () => {
  assert.equal(normalizeScreenResolution(null), null);
  assert.equal(normalizeScreenResolution(undefined), null);
});

test('normalizeScreenResolution refuses what is not a screen size', () => {
  const refused = [
    [{ width: 639, height: 480 }, /at least 640x480/],
    [{ width: 3841, height: 2160 }, /at most 3840x2160/],
    [{ width: 1920, height: 2161 }, /at most 3840x2160/],
    [{ width: 1280.5, height: 720 }, /whole numbers/],
    [{ width: '1280', height: 720 }, /whole numbers/],
    [{ width: 1280 }, /whole numbers/],
    ['1280x720', /must have a width/]
  ];
  for (const [input, message] of refused) {
    assert.throws(() => normalizeScreenResolution(/** @type {any} */ (input)), message, JSON.stringify(input));
  }
});

// A guest agent that records what is written.
const fakeAgent = () => {
  const writes = [];
  const connectQmp = async () => ({
    execute: async (command, args) => {
      if (command === 'guest-file-open') {
        writes.push({ path: args.path });
        return 7;
      }
      if (command === 'guest-file-write') {
        const data = Buffer.from(args['buf-b64'], 'base64');
        writes.at(-1).text = data.toString();
        return { count: data.length, eof: false };
      }
      return {};
    },
    close: () => {}
  });
  return { writes, connectQmp };
};

test('writeGuestScreenResolution writes one line, or "default"', async () => {
  const { writes, connectQmp } = fakeAgent();
  await writeGuestScreenResolution({ dir: '/vm', screenResolution: { width: 1366, height: 768 }, connectQmp });
  await writeGuestScreenResolution({ dir: '/vm', screenResolution: null, connectQmp });
  assert.deepEqual(writes, [
    { path: GUEST_SCREEN_RESOLUTION_FILE, text: '1366x768\n' },
    { path: GUEST_SCREEN_RESOLUTION_FILE, text: 'default\n' }
  ]);
});

test('writeGuestScreenResolution refuses a bad screen resolution without reaching the guest', async () => {
  const { writes, connectQmp } = fakeAgent();
  await assert.rejects(
    writeGuestScreenResolution({ dir: '/vm', screenResolution: { width: 4000, height: 720 }, connectQmp }),
    /at most/
  );
  assert.deepEqual(writes, []);
});

test('writeGuestScreenResolution says what failed', async () => {
  const connectQmp = async () => {
    throw new Error('no agent');
  };
  await assert.rejects(
    writeGuestScreenResolution({ dir: '/vm', screenResolution: null, connectQmp, attempts: 1 }),
    /unable to set the screen resolution: no agent/
  );
});
