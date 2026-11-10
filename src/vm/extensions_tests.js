import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_POLICY_FILES,
  MAX_EXTENSIONS,
  extensionIdOf,
  normalizeExtensions,
  writeGuestExtensions
} from './extensions.js';

const UBLOCK = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const OTHER = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';

test('extensionIdOf reads the id from a bare id or a Chrome Web Store URL', () => {
  assert.equal(extensionIdOf(UBLOCK), UBLOCK);
  assert.equal(extensionIdOf(` ${UBLOCK} `), UBLOCK);
  assert.equal(extensionIdOf(`https://chromewebstore.google.com/detail/ublock-origin-lite/${UBLOCK}`), UBLOCK);
  assert.equal(extensionIdOf(`https://chromewebstore.google.com/detail/${UBLOCK}?hl=en`), UBLOCK);
  assert.equal(extensionIdOf(`https://chrome.google.com/webstore/detail/ublock-origin-lite/${UBLOCK}/`), UBLOCK);
});

test('extensionIdOf refuses anything else', () => {
  for (const value of [
    '',
    'ublock',
    UBLOCK.toUpperCase(),
    `${UBLOCK}z`,
    'zzkjiahejlhfcafbddmgiahcphecmpfh',
    `http://chromewebstore.google.com/detail/x/${UBLOCK}`,
    `https://example.com/detail/x/${UBLOCK}`,
    `https://chromewebstore.google.com/detail/x/${UBLOCK}x`,
    null,
    42
  ]) {
    assert.equal(extensionIdOf(value), null, String(value));
  }
});

test('normalizeExtensions keeps each id once, in order', () => {
  assert.deepEqual(normalizeExtensions([]), []);
  assert.deepEqual(normalizeExtensions([OTHER, `https://chromewebstore.google.com/detail/x/${UBLOCK}`, UBLOCK]), [
    OTHER,
    UBLOCK
  ]);
});

test('normalizeExtensions refuses a bad list or item, or too many', () => {
  assert.throws(() => normalizeExtensions(UBLOCK), /must be a list/);
  assert.throws(() => normalizeExtensions(null), /must be a list/);
  assert.throws(() => normalizeExtensions([UBLOCK, 'nope']), /Not a Chrome Web Store URL or extension id: nope/);
  const many = Array.from({ length: MAX_EXTENSIONS + 1 }, (_, i) => 'a'.repeat(31) + 'abcdefghijklmnop'[i]);
  assert.throws(() => normalizeExtensions(many), /At most 10 extensions/);
});

const fakeAgent = (writes) => async () => ({
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

test('writeGuestExtensions writes a force-install policy where the browser reads it', async () => {
  for (const app of ['chromium', 'chrome']) {
    const writes = [];
    await writeGuestExtensions({ dir: '/vm', app, ids: [UBLOCK, OTHER], connectQmp: fakeAgent(writes) });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, GUEST_POLICY_FILES[app]);
    assert.deepEqual(JSON.parse(writes[0].text), {
      ExtensionInstallForcelist: [
        `${UBLOCK};https://clients2.google.com/service/update2/crx`,
        `${OTHER};https://clients2.google.com/service/update2/crx`
      ]
    });
  }
});

test('writeGuestExtensions says what failed', async () => {
  const connectQmp = async () => {
    throw new Error('no agent');
  };
  await assert.rejects(
    writeGuestExtensions({ dir: '/vm', app: 'chromium', ids: [UBLOCK], connectQmp, attempts: 1 }),
    /unable to add the extensions: no agent/
  );
});
