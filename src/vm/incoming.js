import path from 'node:path';
import { consola } from 'consola/basic';
import { delay } from './host.js';

// For a VM that QEMU starts from a saved state, with -incoming: waits until
// the state has loaded, then lets the VM run on.
const continueIncoming = async (qmp, timeoutMs) => {
  // "inmigrate" while the saved state still loads.
  const deadline = Date.now() + timeoutMs;
  let { status } = await qmp.execute('query-status');
  while (status === 'inmigrate') {
    if (Date.now() > deadline) {
      throw new Error('loading the VM state timed out');
    }
    await delay(200);
    ({ status } = await qmp.execute('query-status'));
  }
  if (status === 'paused') {
    await qmp.execute('cont');
  } else if (status !== 'running') {
    throw new Error(`the VM is ${status} after loading its state`);
  }
};

// The guest clock stopped when the state was saved. The guest agent sets it
// from the VM's hardware clock, which follows the host's. A wrong clock breaks
// TLS and cookies, but not the VM, so a failure here is logged rather than
// thrown.
const setGuestClock = async ({ dir, name, connectQmp, attempts = 20 }) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const agent = await connectQmp(path.join(dir, 'qga.sock'), { agent: true, timeoutMs: 3000 });
      try {
        await agent.execute('guest-set-time');
        return;
      } finally {
        agent.close();
      }
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  consola.warn(`QEMU unable to set the clock of browser VM ${name}`, {
    'event.domain': 'qemu',
    'error.type': lastError instanceof Error ? lastError.message : String(lastError)
  });
};

export { continueIncoming, setGuestClock };
