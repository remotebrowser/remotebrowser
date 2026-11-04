import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readVncFrame, readVncScreenSize } from './vnc.js';

// A VNC server that answers the handshake as Xvnc does, in small pieces.
const fakeVnc = async (t, { types = [1], width = 1366, height = 768, update = [] } = {}) => {
  const received = [];
  const server = createServer((socket) => {
    socket.on('data', (data) => {
      received.push([...data]);
      if (received.length === 1) {
        socket.write(Buffer.from([types.length, ...types]));
      } else if (received.length === 2) {
        socket.write(Buffer.alloc(4));
      } else if (received.length === 3) {
        const init = Buffer.alloc(24);
        init.writeUInt16BE(width, 0);
        init.writeUInt16BE(height, 2);
        init.writeUInt32BE(4, 20);
        socket.write(init.subarray(0, 3));
        setTimeout(() => socket.write(Buffer.concat([init.subarray(3), Buffer.from('QEMU')])), 10);
      } else if (received.length === 4) {
        for (const [i, chunk] of update.entries()) {
          setTimeout(() => socket.write(chunk), i * 5);
        }
      }
    });
    socket.write('RFB 003.008\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { port, received };
};

test('readVncScreenSize reads the screen size from the handshake, as a shared viewer', async (t) => {
  const { port, received } = await fakeVnc(t);
  assert.deepEqual(await readVncScreenSize(port, 1000), { width: 1366, height: 768 });
  assert.deepEqual(received, [[...Buffer.from('RFB 003.008\n')], [1], [1]]);
});

test('readVncScreenSize refuses a server that asks for a password', async (t) => {
  const { port } = await fakeVnc(t, { types: [2] });
  await assert.rejects(readVncScreenSize(port, 1000), /asks for a password/);
});

test('readVncScreenSize fails when nothing listens', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(readVncScreenSize(port, 1000), /ECONNREFUSED/);
});

const rect = (x, y, w, h, rgb) => {
  const header = Buffer.alloc(12);
  [x, y, w, h].forEach((value, i) => header.writeUInt16BE(value, i * 2));
  return Buffer.concat([header, Buffer.alloc(w * h * 4).fill(Buffer.from([...rgb, 0]))]);
};

test('readVncFrame asks for the whole screen as raw RGBX, and puts the rectangles in place', async (t) => {
  const bell = Buffer.from([2]);
  const cutText = Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 104, 105]);
  const left = Buffer.concat([Buffer.from([0, 0, 0, 1]), rect(0, 0, 1, 2, [255, 0, 0])]);
  const right = Buffer.concat([Buffer.from([0, 0, 0, 1]), rect(1, 0, 1, 2, [0, 0, 255])]);
  const { port, received } = await fakeVnc(t, {
    width: 2,
    height: 2,
    update: [bell, cutText, left.subarray(0, 7), left.subarray(7), right]
  });
  const frame = await readVncFrame(port, 1000);
  assert.deepEqual(
    { width: frame.width, height: frame.height, data: [...frame.data] },
    { width: 2, height: 2, data: [255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 255, 0] }
  );
  const sent = Buffer.from(received.slice(3).flat());
  assert.deepEqual([...sent.subarray(0, 20)], [0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
  assert.deepEqual([...sent.subarray(20)], [2, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 2]);
});

test('readVncFrame refuses an encoding it did not ask for', async (t) => {
  const tight = rect(0, 0, 1, 1, [0, 0, 0]);
  tight.writeInt32BE(7, 8);
  const { port } = await fakeVnc(t, {
    width: 1,
    height: 1,
    update: [Buffer.concat([Buffer.from([0, 0, 0, 1]), tight])]
  });
  await assert.rejects(readVncFrame(port, 1000), /not asked for/);
});
