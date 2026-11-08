import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectDbus, decodeMessage, encodeMessage, splitSignature } from './dbus.js';

test('splitSignature splits complete types', () => {
  assert.deepEqual(splitSignature('iiay(yv)a{sv}h'), ['i', 'i', 'ay', '(yv)', 'a{sv}', 'h']);
  assert.throws(() => splitSignature('a('), /Bad D-Bus signature/);
  assert.throws(() => splitSignature('z'), /Bad D-Bus signature/);
});

test('encodeMessage and decodeMessage agree, with aligned arrays, variants, and dicts', () => {
  const message = {
    type: 1,
    serial: 7,
    flags: 1,
    path: '/org/qemu/Display1/Listener',
    interface: 'org.qemu.Display1.Listener',
    member: 'CursorDefine',
    signature: 'iiiiaya{sv}as',
    body: [
      32,
      32,
      -1,
      2,
      Buffer.from([1, 2, 3]),
      [
        ['Interfaces', ['as', ['a', 'bc']]],
        ['n', ['t', 5n]]
      ],
      []
    ]
  };
  const bytes = encodeMessage(message);
  const extra = Buffer.concat([bytes, Buffer.from([0x6c])]);
  const decoded = decodeMessage(extra);
  assert.equal(decoded.length, bytes.length);
  assert.deepEqual({ ...decoded.message, body: undefined }, { ...message, body: undefined });
  const [w, h, hx, hy, data, dict, list] = decoded.message.body;
  assert.deepEqual([w, h, hx, hy, [...data], dict, list], [32, 32, -1, 2, [1, 2, 3], message.body[5], []]);
  assert.equal(decodeMessage(bytes.subarray(0, bytes.length - 1)), null);
  assert.equal(decodeMessage(bytes.subarray(0, 10)), null);
});

// A peer that authenticates as GDBus does, then calls `MouseSet` on the client
// and answers its calls.
const fakePeer = async ({ agreeFds = true } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rb-dbus-'));
  const socketPath = path.join(dir, 'peer.sock');
  const received = [];
  const server = createServer((socket) => {
    let text = '';
    let buffer = Buffer.alloc(0);
    let began = false;
    socket.on('data', (data) => {
      let chunk = data;
      if (!began) {
        text += chunk.toString('latin1');
        // The first call may come in the same chunk as BEGIN.
        const begin = text.indexOf('BEGIN\r\n');
        if (begin >= 0) {
          chunk = Buffer.from(text.slice(begin + 7), 'latin1');
          text = text.slice(0, begin + 7);
        }
        if (text.startsWith('\0AUTH EXTERNAL ') && text.endsWith('\r\n') && !text.includes('NEGOTIATE')) {
          socket.write('OK 0123456789abcdef0123456789abcdef\r\n');
        } else if (text.endsWith('NEGOTIATE_UNIX_FD\r\n')) {
          socket.write(agreeFds ? 'AGREE_UNIX_FD\r\n' : 'ERROR\r\n');
        } else if (text.endsWith('BEGIN\r\n')) {
          began = true;
          socket.write(
            encodeMessage({ type: 1, serial: 1, path: '/l', member: 'MouseSet', signature: 'iii', body: [3, 4, 1] })
          );
          socket.write(
            encodeMessage({
              type: 1,
              serial: 2,
              flags: 1,
              path: '/l',
              member: 'UpdateMap',
              signature: 'iiii',
              body: [0, 0, 1, 1]
            })
          );
        }
        if (!began) {
          return;
        }
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (let decoded = decodeMessage(buffer); decoded; decoded = decodeMessage(buffer)) {
        buffer = buffer.subarray(decoded.length);
        received.push(decoded.message);
        const { message } = decoded;
        if (message.type === 1 && message.member === 'Fail') {
          socket.write(
            encodeMessage({
              type: 3,
              serial: 9,
              replySerial: message.serial,
              errorName: 'org.example.Nope',
              signature: 's',
              body: ['no']
            })
          );
        } else if (message.type === 1) {
          socket.write(
            encodeMessage({ type: 2, serial: 10, replySerial: message.serial, signature: 's', body: ['ok'] })
          );
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { socketPath, received, close: () => server.close() };
};

test('connectDbus authenticates, answers calls unless no reply is expected, and gets replies', async () => {
  const peer = await fakePeer();
  const calls = [];
  const socket = connect(peer.socketPath);
  const dbus = await connectDbus(socket, {
    uid: 1000,
    onCall: (message) => {
      calls.push([message.member, message.body]);
      return message.member === 'MouseSet' ? ['s', ['seen']] : undefined;
    }
  });
  const ok = dbus.prepareCall({ path: '/p', interface: 'i.f', member: 'Hi', signature: 'u', body: [1] });
  socket.write(ok.bytes);
  assert.deepEqual(await ok.replied, ['ok']);
  const nope = dbus.prepareCall({ path: '/p', interface: 'i.f', member: 'Fail' });
  socket.write(nope.bytes);
  await assert.rejects(nope.replied, /org.example.Nope: no/);
  assert.deepEqual(calls, [
    ['MouseSet', [3, 4, 1]],
    ['UpdateMap', [0, 0, 1, 1]]
  ]);
  // Only MouseSet expects a reply; UpdateMap said not to.
  const replies = peer.received.filter(({ type }) => type === 2);
  assert.deepEqual(
    replies.map(({ replySerial, body }) => [replySerial, body]),
    [[1, ['seen']]]
  );
  const closed = new Promise((resolve) => dbus.onClose(resolve));
  dbus.close();
  assert.match((await closed).message, /closed/);
  peer.close();
});

test('connectDbus refuses a peer that cannot pass fds', async () => {
  const peer = await fakePeer({ agreeFds: false });
  await assert.rejects(connectDbus(connect(peer.socketPath)), /cannot pass fds/);
  peer.close();
});
