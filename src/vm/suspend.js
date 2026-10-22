import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { consola } from 'consola/basic';
import { compressSuspendedState, hasSuspendedState, loadableSuspendedState, removeSuspendedState } from './compress.js';
import { checkImage } from './image.js';
import { continueIncoming, setGuestClock } from './incoming.js';
import { removeSuspendedPreviews, writeSuspendedPreviews } from './previews.js';
import { suspendVm } from './save.js';
import { isWellFormedBrowserId, readPid, readPort, vmName } from './state.js';

// A suspended VM: QEMU saves its memory and devices to suspended.state in the
// VM dir and exits, which frees the VM's memory, and the state is compressed,
// to about a quarter. Resuming starts the same machine from that state, and
// the browser carries on.
//
// It takes the VM client's host hooks and QEMU start-up, so tests can fake
// both in one place.
const createSuspender = ({
  vmDir,
  isAlive,
  kill,
  connectQmp,
  startVm,
  waitForExit,
  browserIsRunning,
  suspendTimeoutMs,
  zstd
}) => {
  const browserIsSuspended = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return false;
    }
    return (await hasSuspendedState(vmDir(browserId))) && !(await browserIsRunning(browserId));
  };

  // Saves the VM's memory and devices to suspended.state, stops QEMU, and
  // compresses the state. The overlay stays, so resumeBrowser can carry on. A
  // failed save leaves the VM running as it was. `previews` are pictures of
  // its pages, taken before, kept only once the suspend has worked.
  const suspendBrowser = async (browserId, { previews = [] } = {}) => {
    if (!isWellFormedBrowserId(browserId)) {
      throw new Error('Invalid browser id');
    }
    const name = vmName(browserId);
    const dir = vmDir(browserId);
    const pid = await readPid(dir);
    if (pid === null || !(await isAlive(pid, dir))) {
      throw new Error(`${name} is not running`);
    }
    await suspendVm({ dir, connectQmp, timeoutMs: suspendTimeoutMs });
    await waitForExit(pid, dir);
    const compressed = await compressSuspendedState(dir, { binary: zstd });
    // Only nice to have: a browser that is suspended without them still resumes.
    await writeSuspendedPreviews(dir, previews).catch((error) =>
      consola.warn(`Unable to keep the page previews of ${name}: ${error.message}`)
    );
    consola.log(`QEMU suspended browser VM ${name}`, {
      'event.domain': 'qemu',
      'rb.runtime': 'qemu',
      ...(compressed && { 'rb.state_bytes': compressed.before, 'rb.state_compressed_bytes': compressed.after })
    });
  };

  // Starts the suspended VM again from suspended.state, on the ports it had if
  // they are still free, and sets its clock, which stopped while suspended.
  const resumeBrowser = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      throw new Error('Invalid browser id');
    }
    const name = vmName(browserId);
    const dir = vmDir(browserId);
    if (!(await browserIsSuspended(browserId))) {
      throw new Error(`${name} is not suspended`);
    }
    const machine = JSON.parse(await readFile(path.join(dir, 'machine.json'), 'utf8'));
    await checkImage(machine).catch((error) => {
      throw new Error(`Unable to resume ${name}: ${error.message}`, { cause: error });
    });
    const incoming = await loadableSuspendedState(dir, { binary: zstd }).catch((error) => {
      throw new Error(`Unable to resume ${name}: ${error.message}`, { cause: error });
    });
    const ports = { cdp: await readPort(dir, 'cdp-port'), vnc: await readPort(dir, 'vnc-port') };
    const { pid } = await startVm({
      name,
      dir,
      machine,
      incoming,
      ports: Number.isInteger(ports.cdp) && Number.isInteger(ports.vnc) ? ports : undefined
    });
    try {
      const qmp = await connectQmp(path.join(dir, 'qmp.sock'));
      try {
        await continueIncoming(qmp, suspendTimeoutMs);
      } finally {
        qmp.close();
      }
    } catch (error) {
      // Keep suspended.state, so the resume can be tried again.
      kill(pid, 'SIGKILL');
      await waitForExit(pid, dir);
      throw new Error(`Unable to resume ${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
    await removeSuspendedState(dir);
    await removeSuspendedPreviews(dir);
    await setGuestClock({ dir, name, connectQmp });
    consola.log(`QEMU resumed browser VM ${name}`, { 'event.domain': 'qemu', 'rb.runtime': 'qemu' });
    return { browserId };
  };

  return { browserIsSuspended, suspendBrowser, resumeBrowser };
};

export { createSuspender };
