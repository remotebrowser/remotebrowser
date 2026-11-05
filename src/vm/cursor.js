import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDbus } from './dbus.js';

// VNC drops the virtio-gpu cursor, so read the pointer from QEMU's D-Bus display.
// Node cannot pass sockets to QEMU, so vm/send-fd sends argv bytes with fd 3 over fd 0.
const SEND_FD = fileURLToPath(new URL('../../vm/send-fd', import.meta.url));

const LISTENER = 'org.qemu.Display1.Listener';
// QEMU then shares the screen as memory and sends only the changed bounds.
const MAP = 'org.qemu.Display1.Listener.Unix.Map';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

// Sends `bytes` with one end of a new socket pair, and returns the other end.
const sendWithSocket = async ({ socket, bytes, sendFd }) => {
  const child = spawn(sendFd, [bytes.toString('hex')], { stdio: [socket, 'ignore', 'pipe', 'pipe'] });
  const stderr = [];
  child.stdio[2]?.on('data', (chunk) => stderr.push(chunk));
  const [code] = await Promise.race([
    once(child, 'exit'),
    once(child, 'error').then(([error]) => {
      throw error;
    })
  ]);
  // Node stops reading a socket that it gives to a child.
  socket.resume();
  const kept = /** @type {import('node:net').Socket} */ (child.stdio[3]);
  if (code !== 0) {
    kept.destroy();
    throw new Error(`unable to pass a socket to QEMU: ${Buffer.concat(stderr).toString().trim() || `exit ${code}`}`);
  }
  return kept;
};

// A QMP session on a socket that sendWithSocket can write to as well.
const openRawQmp = async (socketPath) => {
  const socket = connect(socketPath);
  socket.setTimeout(10000, () => socket.destroy(new Error(`No reply on ${socketPath}`)));
  await once(socket, 'connect');
  let buffer = '';
  const waiters = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      const message = line ? JSON.parse(line) : null;
      // QMP sends events at any time; they are not replies.
      if (message && !('event' in message)) {
        waiters.shift()?.resolve(message);
      }
    }
  });
  socket.on('error', (error) => waiters.splice(0).forEach(({ reject }) => reject(error)));
  socket.on('close', () => waiters.splice(0).forEach(({ reject }) => reject(new Error(`${socketPath} closed`))));
  const nextReply = () => new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  const check = (reply, command) => {
    if (reply.error) {
      throw new Error(`${command}: ${reply.error.desc ?? JSON.stringify(reply.error)}`);
    }
    return reply.return;
  };
  await nextReply();
  const execute = async (command, args) => {
    const replied = nextReply();
    socket.write(`${JSON.stringify(args ? { execute: command, arguments: args } : { execute: command })}\n`);
    return check(await replied, command);
  };
  await execute('qmp_capabilities');
  return { socket, nextReply, check, execute, close: () => socket.destroy() };
};

// QEMU waits for the listener to ack each frame, so attach only briefly.
const READ_TIMEOUT_MS = 2000;

/**
 * The guest's pointer in screen pixels, or null if the guest has not drawn it.
 * @param {{dir: string, sendFd?: string, timeoutMs?: number}} params
 * @returns {Promise<{x: number, y: number, visible: boolean} | null>}
 */
const readPointer = async ({ dir, sendFd = SEND_FD, timeoutMs = READ_TIMEOUT_MS }) => {
  const qmp = await openRawQmp(path.join(dir, 'qmp.sock'));
  let bus;
  try {
    const fdname = `rb-display-${process.pid}-${Date.now()}`;
    const getfd = `${JSON.stringify({ execute: 'getfd', arguments: { fdname } })}\n`;
    const replied = qmp.nextReply();
    bus = await sendWithSocket({ socket: qmp.socket, bytes: Buffer.from(getfd), sendFd });
    qmp.check(await replied, 'getfd');
    await qmp.execute('add_client', { protocol: '@dbus-display', fdname });
  } catch (error) {
    bus?.destroy();
    throw error;
  } finally {
    qmp.close();
  }

  let cursor = null;
  let hotspot = { x: 0, y: 0 };
  let told;
  const toldPromise = new Promise((resolve) => {
    told = resolve;
  });
  const onCall = (message) => {
    if (message.interface === PROPERTIES && (message.member === 'GetAll' || message.member === 'Get')) {
      const all = message.body[0] === LISTENER ? [['Interfaces', ['as', [MAP]]]] : [];
      if (message.member === 'GetAll') {
        return ['a{sv}', [all]];
      }
      const found = all.find(([name]) => name === message.body[1]);
      return found ? ['v', [found[1]]] : undefined;
    }
    // The cursor's top left corner, and where in it the pointer points.
    if (message.member === 'CursorDefine') {
      const [, , x, y] = message.body;
      hotspot = { x, y };
    } else if (message.member === 'MouseSet') {
      const [x, y, visible] = message.body;
      cursor = { x, y, visible: Boolean(visible) };
      told();
    }
    return undefined;
  };

  let busConnection;
  let listener;
  let timer;
  try {
    busConnection = await connectDbus(bus);
    const register = busConnection.prepareCall({
      path: '/org/qemu/Display1/Console_0',
      interface: 'org.qemu.Display1.Console',
      member: 'RegisterListener',
      signature: 'h',
      body: [0],
      unixFds: 1
    });
    const listenerSocket = await sendWithSocket({ socket: bus, bytes: register.bytes, sendFd });
    // QEMU waits for this side to authenticate before it replies.
    [listener] = await Promise.all([connectDbus(listenerSocket, { onCall }), register.replied]);
    await Promise.race([
      toldPromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
      new Promise((_resolve, reject) => listener.onClose(reject))
    ]);
  } finally {
    clearTimeout(timer);
    listener?.close();
    busConnection?.close();
    bus.destroy();
  }
  return cursor && { x: cursor.x + hotspot.x, y: cursor.y + hotspot.y, visible: cursor.visible };
};

export { readPointer };
