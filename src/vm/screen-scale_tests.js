import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCREEN_SCALE,
  GUEST_SCREEN_SCALE_FILE,
  normalizeScreenScale,
  writeGuestScreenScale
} from './screen-scale.js';

test('normalizeScreenScale takes a scale in percent', () => {
  for (const scale of [100, 125, 150, 175, 200, 300, DEFAULT_SCREEN_SCALE]) {
    assert.equal(normalizeScreenScale(scale), scale);
  }
});

test('normalizeScreenScale treats nothing as the default', () => {
  assert.equal(normalizeScreenScale(null), null);
  assert.equal(normalizeScreenScale(undefined), null);
});

test('normalizeScreenScale refuses what is not a scale in steps of 25%', () => {
  const refused = [
    [75, /from 100% to 300%/],
    [325, /from 100% to 300%/],
    [110, /in steps of 25%/],
    [1.5, /whole number/],
    ['150', /whole number/],
    [{}, /whole number/]
  ];
  for (const [input, message] of refused) {
    assert.throws(() => normalizeScreenScale(/** @type {any} */ (input)), message, JSON.stringify(input));
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

test('writeGuestScreenScale writes one line, or "default"', async () => {
  const { writes, connectQmp } = fakeAgent();
  await writeGuestScreenScale({ dir: '/vm', screenScale: 150, connectQmp });
  await writeGuestScreenScale({ dir: '/vm', screenScale: null, connectQmp });
  assert.deepEqual(writes, [
    { path: GUEST_SCREEN_SCALE_FILE, text: '150\n' },
    { path: GUEST_SCREEN_SCALE_FILE, text: 'default\n' }
  ]);
});

test('writeGuestScreenScale refuses a bad scale without reaching the guest', async () => {
  const { writes, connectQmp } = fakeAgent();
  await assert.rejects(writeGuestScreenScale({ dir: '/vm', screenScale: 90, connectQmp }), /from 100%/);
  assert.deepEqual(writes, []);
});

test('writeGuestScreenScale says what failed', async () => {
  const connectQmp = async () => {
    throw new Error('no agent');
  };
  await assert.rejects(
    writeGuestScreenScale({ dir: '/vm', screenScale: null, connectQmp, attempts: 1 }),
    /unable to set the screen scale: no agent/
  );
});
