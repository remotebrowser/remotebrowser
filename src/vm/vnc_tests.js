import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readVncScreenSize } from './vnc.js';

// A VNC server that answers the handshake as Xvnc does, in small pieces.
const fakeVnc = async (t, { types = [1], width = 1366, height = 768 } = {}) => {
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
        socket.write(init.subarray(0, 3));
        setTimeout(() => socket.write(init.subarray(3)), 10);
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
