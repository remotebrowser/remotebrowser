import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './host.js';

// Pauses the VM on this QMP session and saves its memory and devices to
// `file`. QEMU keeps running, paused, so the caller decides whether to quit
// it. A failed save leaves the VM running as it was, and no file.
const saveState = async (qmp, file, timeoutMs) => {
  const partial = `${file}.part`;
  // Freeze the guest first, so the saved state is one consistent moment.
  await qmp.execute('stop');
  await rm(partial, { force: true });
  try {
    await qmp.execute('migrate', { uri: `file:${partial}` });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { status } = await qmp.execute('query-migrate');
      if (status === 'completed') {
        break;
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(`saving the VM state ${status}`);
      }
      if (Date.now() > deadline) {
        throw new Error('saving the VM state timed out');
      }
      await delay(200);
    }
  } catch (error) {
    await qmp.execute('migrate_cancel').catch(() => {});
    await qmp.execute('cont').catch(() => {});
    await rm(partial, { force: true });
    throw error;
  }
  // Only a complete file counts.
  await rename(partial, file);
};

// Saves a running VM to suspended.state in its dir, then quits QEMU, which
// frees the VM's memory. The overlay stays, so the VM can carry on from both.
// The caller waits for QEMU to exit.
const suspendVm = async ({ dir, connectQmp, timeoutMs }) => {
  const qmp = await connectQmp(path.join(dir, 'qmp.sock'));
  try {
    await saveState(qmp, path.join(dir, 'suspended.state'), timeoutMs);
    await qmp.execute('quit').catch(() => {});
  } finally {
    qmp.close();
  }
};

export { saveState, suspendVm };
