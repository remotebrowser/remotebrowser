import { once } from 'node:events';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const QMP_TIMEOUT_MS = 10000;

// A session on QEMU's QMP socket, or with `agent` on the guest agent's socket,
// which speaks the same JSON but has no greeting or capabilities step.
const openQmp = async (socketPath, { agent = false, timeoutMs = QMP_TIMEOUT_MS } = {}) => {
  const socket = connect(socketPath);
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`No reply on ${socketPath}`)));
  await once(socket, 'connect');
  const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const nextReply = async () => {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) {
        throw new Error(`${socketPath} closed before replying`);
      }
      if (!value.trim()) {
        continue;
      }
      const message = JSON.parse(value);
      // QMP sends events at any time; they are not replies.
      if (!('event' in message)) {
        return message;
      }
    }
  };
  const send = (command, args) =>
    socket.write(`${JSON.stringify(args ? { execute: command, arguments: args } : { execute: command })}\n`);
  const execute = async (command, args) => {
    send(command, args);
    const reply = await nextReply();
    if (reply.error) {
      throw new Error(`${command}: ${reply.error.desc ?? JSON.stringify(reply.error)}`);
    }
    return reply.return;
  };
  try {
    if (agent) {
      // The agent may still hold a reply meant for an earlier client. One
      // sync with a fresh id, then reading up to its reply, skips past it.
      const token = Math.floor(Math.random() * 2 ** 31);
      send('guest-sync', { id: token });
      while ((await nextReply()).return !== token) {
        // A stale reply; read on.
      }
    } else {
      await nextReply(); // the greeting
      await execute('qmp_capabilities');
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return { execute, close: () => socket.destroy() };
};

export { openQmp };
