import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { openQmp } from './qmp.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'rb-qmp-tests-'));

// openQmp against a real socket, speaking the protocol as QEMU does.
const qmpServer = async (socketPath, { agent = false } = {}) => {
  const received = [];
  const server = createServer((socket) => {
    socket.on('error', () => {});
    if (!agent) {
      socket.write(`${JSON.stringify({ QMP: { version: {}, capabilities: [] } })}\r\n`);
    } else {
      // A reply left over from an earlier client.
      socket.write(`${JSON.stringify({ return: 7 })}\n`);
    }
    createInterface({ input: socket }).on('line', (line) => {
      const { execute, arguments: args } = JSON.parse(line);
      received.push(execute);
      if (execute === 'query-status') {
        // Events may arrive before the reply.
        socket.write(`${JSON.stringify({ event: 'RESUME', timestamp: {} })}\r\n`);
        socket.write(`${JSON.stringify({ return: { status: 'running' } })}\r\n`);
      } else if (execute === 'guest-sync') {
        socket.write(`${JSON.stringify({ return: args.id })}\n`);
      } else if (execute === 'bad') {
        socket.write(`${JSON.stringify({ error: { class: 'GenericError', desc: 'no such command' } })}\r\n`);
      } else {
        socket.write(`${JSON.stringify({ return: {} })}\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { received, close: () => new Promise((resolve) => server.close(resolve)) };
};

test('openQmp negotiates capabilities, skips events, and reports errors', async () => {
  const socketPath = path.join(tempDir(), 'qmp.sock');
  const server = await qmpServer(socketPath);
  const qmp = await openQmp(socketPath);
  try {
    assert.deepEqual(await qmp.execute('query-status'), { status: 'running' });
    await assert.rejects(qmp.execute('bad'), /bad: no such command/);
  } finally {
    qmp.close();
    await server.close();
  }
  assert.deepEqual(server.received, ['qmp_capabilities', 'query-status', 'bad']);
});

test('openQmp syncs with the guest agent past a stale reply', async () => {
  const socketPath = path.join(tempDir(), 'qga.sock');
  const server = await qmpServer(socketPath, { agent: true });
  const agent = await openQmp(socketPath, { agent: true });
  try {
    assert.deepEqual(await agent.execute('guest-set-time'), {});
  } finally {
    agent.close();
    await server.close();
  }
  assert.equal(server.received[0], 'guest-sync');
  assert.equal(server.received.at(-1), 'guest-set-time');
});
