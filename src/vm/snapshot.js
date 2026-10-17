import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { consola } from 'consola/basic';
import { fetchWebSocketDebuggerUrl } from './cdp.js';
import * as host from './host.js';
import { ARCHES, MACHINE_VERSION, buildQemuArgs, detectAccel } from './qemu.js';
import { checkImage, fileStamp } from './image.js';
import { openQmp } from './qmp.js';
import { saveState } from './save.js';
import { LOG_ATTRIBUTES, step } from './step.js';

// A snapshot is a VM booted once, until the guest is ready but before the
// browser starts, and saved with its memory, so a new VM starts from it in
// seconds. Its dir holds:
//
//   machine.json    the machine, and the image build it runs on
//   overlay.qcow2   the disk at that moment, on top of the image
//   vm.state        the memory and devices at that moment
//   console.log     the serial console until then
//
// It is saved with the app's own QEMU args, so the app, and vm/scripts/run.js,
// can start VMs from it. See startFromSnapshot in local.js.

// The machine a snapshot was saved with, or null when there is no complete
// snapshot.
const readSnapshot = async (snapshotDir) => {
  const machine = await readFile(path.join(snapshotDir, 'machine.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const hasState = await stat(path.join(snapshotDir, 'vm.state')).then(
    () => true,
    () => false
  );
  return machine && hasState ? machine : null;
};

// Whether the snapshot fits this machine, and, when `image` is given, was
// saved from that build of the image; if not, why not. A snapshot of an
// older build still works, as long as that build is there.
const snapshotStatus = async ({ snapshotDir, image, arch, memory, cpus }) => {
  const saved = await readSnapshot(snapshotDir);
  if (!saved) {
    return { current: false, reason: `No snapshot in ${snapshotDir}` };
  }
  if (image && saved.image !== path.resolve(image)) {
    return { current: false, reason: `The snapshot is of an older build of the image, not ${image}` };
  }
  const broken = await checkImage(saved).then(
    () => null,
    (error) => error.message
  );
  if (broken) {
    return { current: false, reason: `The snapshot is unusable: ${broken}` };
  }
  if (saved.version !== MACHINE_VERSION) {
    return { current: false, reason: 'The snapshot is of an older QEMU machine' };
  }
  const have = `${saved.arch} ${saved.memory} ${saved.cpus}`;
  const want = `${arch} ${memory} ${cpus}`;
  if (have !== want) {
    return { current: false, reason: `The snapshot has ${have}; asked for ${want}` };
  }
  return { current: true };
};

// The line guest-ready.service writes to the console once the guest is up.
const GUEST_READY = 'remotebrowser: guest ready';

// Boots the image, waits until the guest is ready, and saves the VM. The
// browser is not running yet: it starts in each VM after the VM starts from
// the snapshot (see chromium-start.timer in vm/files), so it gets random
// numbers of its own.
// The new snapshot is built next to the old one, which stays usable until
// the new one is complete.
const takeSnapshot = async ({
  snapshotDir,
  image,
  arch,
  memory,
  cpus,
  bootTimeoutMs = 600000,
  saveTimeoutMs = 120000
}) => {
  const dir = `${path.resolve(snapshotDir)}.new.${process.pid}`;
  const accel = await detectAccel();
  if (accel === 'tcg') {
    consola.warn('QEMU has no KVM or HVF here; the snapshot boots under slow emulation', LOG_ATTRIBUTES);
  }
  if (!ARCHES[arch].vmgenid) {
    consola.warn(`QEMU VMs from an ${arch} snapshot share the guest kernel's random number state`, LOG_ATTRIBUTES);
  }
  const machine = {
    arch,
    accel,
    image: path.resolve(image),
    imageStamp: await fileStamp(image),
    memory,
    cpus,
    version: MACHINE_VERSION
  };

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  /** @type {number | undefined} */
  let pid;
  try {
    const overlay = path.join(dir, 'overlay.qcow2');
    const created = await host.run([
      'qemu-img',
      'create',
      '-q',
      '-f',
      'qcow2',
      '-b',
      machine.image,
      '-F',
      'qcow2',
      overlay
    ]);
    if (created.code !== 0) {
      throw new Error(created.stderr.trim() || `qemu-img exited with code ${created.code}`);
    }
    const cdpHostPort = await host.freePort();
    let vncHostPort = await host.freePort();
    while (vncHostPort === cdpHostPort) {
      vncHostPort = await host.freePort();
    }
    const args = buildQemuArgs({ name: 'snapshot', dir, overlay, cdpHostPort, vncHostPort, ...machine });
    const started = await host.start([ARCHES[arch].binary, ...args], path.join(dir, 'qemu.log'));
    pid = started.pid;
    let exited = false;
    void started.exited.then(() => {
      exited = true;
    });

    const baseUrl = `http://127.0.0.1:${cdpHostPort}`;
    const consoleLog = path.join(dir, 'console.log');
    const waitForGuest = async () => {
      const deadline = Date.now() + bootTimeoutMs;
      for (;;) {
        if (exited) {
          await copyFile(consoleLog, `${snapshotDir}.failed.log`).catch(() => {});
          const log = await host.lastLines(path.join(dir, 'qemu.log'));
          throw new Error(
            `QEMU quit before the guest was ready; the guest console is in ${snapshotDir}.failed.log${log ? `\n${log}` : ''}`
          );
        }
        if (Date.now() > deadline) {
          throw new Error('The guest was not ready in time');
        }
        if ((await readFile(consoleLog, 'utf8').catch(() => '')).includes(GUEST_READY)) {
          return;
        }
        await host.delay(200);
      }
    };
    // A browser running in the snapshot would share its random number state
    // with every VM started from it.
    const checkNoBrowser = async () => {
      const answers = await fetchWebSocketDebuggerUrl(globalThis.fetch, baseUrl, 2000).then(
        () => true,
        () => false
      );
      if (answers) {
        throw new Error('The browser runs at boot, so the image is from an older vm/; delete it to build it again');
      }
    };
    const saveAndQuit = async () => {
      const qmp = await openQmp(path.join(dir, 'qmp.sock'));
      try {
        await saveState(qmp, path.join(dir, 'vm.state'), saveTimeoutMs);
        await qmp.execute('quit').catch(() => {});
      } finally {
        qmp.close();
      }
      // QEMU is detached and unref'd, so its exit event alone would not keep
      // this process alive to see it.
      const exitDeadline = Date.now() + 10000;
      while ((await host.isAlive(started.pid, dir)) && Date.now() < exitDeadline) {
        await host.delay(100);
      }
      if (await host.isAlive(started.pid, dir)) {
        host.kill(started.pid, 'SIGKILL');
      }
    };

    await step(`Booting ${image} until the guest is ready`, waitForGuest);
    await checkNoBrowser();
    await step('Saving the VM state', saveAndQuit);
    pid = undefined;

    await writeFile(path.join(dir, 'machine.json'), JSON.stringify(machine));
    await rm(path.join(dir, 'qemu.pid'), { force: true });
    await rm(snapshotDir, { recursive: true, force: true });
    await rename(dir, snapshotDir);
  } catch (error) {
    if (pid) {
      host.kill(pid, 'SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
};

export { fileStamp, readSnapshot, snapshotStatus, takeSnapshot };
