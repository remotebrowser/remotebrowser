import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_WEBGL_FILE, writeGuestWebgl } from './webgl.js';

test('writeGuestWebgl writes the flag that ignores the GPU blocklist', async () => {
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
  await writeGuestWebgl({ dir: '/vm', connectQmp });
  assert.deepEqual(writes, [{ path: GUEST_WEBGL_FILE, text: 'WEBGL_FLAGS=--ignore-gpu-blocklist\n' }]);
});

test('writeGuestWebgl says what failed', async () => {
  const connectQmp = async () => {
    throw new Error('no agent');
  };
  await assert.rejects(writeGuestWebgl({ dir: '/vm', connectQmp, attempts: 1 }), /unable to enable WebGL: no agent/);
});
