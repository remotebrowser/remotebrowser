import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_BROWSER_APP_FILE, resolveBrowserApp, writeGuestBrowserApp } from './browser-app.js';

test('resolveBrowserApp takes any case and the google-chrome alias', () => {
  assert.equal(resolveBrowserApp('chromium'), 'chromium');
  assert.equal(resolveBrowserApp('Chrome'), 'chrome');
  assert.equal(resolveBrowserApp('google-chrome'), 'chrome');
  for (const name of ['firefox', '', null, 1, 'toString']) {
    assert.equal(resolveBrowserApp(name), null, String(name));
  }
});

test('writeGuestBrowserApp writes the binary to run', async () => {
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
  await writeGuestBrowserApp({ dir: '/vm', app: 'chrome', connectQmp });
  assert.deepEqual(writes, [{ path: GUEST_BROWSER_APP_FILE, text: 'BROWSER_APP=/usr/bin/google-chrome-stable\n' }]);
});

test('writeGuestBrowserApp says what failed', async () => {
  const connectQmp = async () => {
    throw new Error('no agent');
  };
  await assert.rejects(
    writeGuestBrowserApp({ dir: '/vm', app: 'chrome', connectQmp, attempts: 1 }),
    /unable to pick Google Chrome: no agent/
  );
});

test('writeGuestBrowserApp succeeds on Windows without reaching the guest', async () => {
  let reached = false;
  const connectQmp = async () => {
    reached = true;
    throw new Error('no agent');
  };
  for (const app of ['chromium', 'chrome']) {
    await writeGuestBrowserApp({ dir: '/vm', app, connectQmp, guest: 'windows' });
  }
  assert.equal(reached, false);
});
