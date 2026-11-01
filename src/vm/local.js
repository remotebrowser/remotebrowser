import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { consola } from 'consola/basic';
import { vmConfig } from './config.js';
import * as host from './host.js';
import { compressSuspendedState, hasSuspendedState, loadableSuspendedState, removeSuspendedState } from './compress.js';
import { checkImage } from './image.js';
import { continueIncoming, setGuestClock } from './incoming.js';
import { vmLayout } from './layout.js';
import { ARCHES, MAX_SOCKET_PATH, buildQemuArgs } from './qemu.js';
import { machineOs } from './os.js';
import { openQmp } from './qmp.js';
import { suspendVm } from './save.js';
import { readSnapshot, snapshotStatus } from './snapshot.js';
import { readPid, readPort } from './state.js';
import { LOG_ATTRIBUTES, qemu } from './step.js';

// One VM started by hand from the snapshot, to test the image without the
// app. QEMU runs in the foreground, with the terminal as the guest console.
// Its dir is laid out like an app VM's:
//
//   machine.json      the snapshot's machine
//   overlay.qcow2     the VM's disk, a copy of the snapshot's
//   cdp-port          the host port that CDP is forwarded to
//   vnc-port          the host port that VNC is forwarded to
//   qmp.sock          QEMU's control socket
//   qga.sock          the guest agent's socket
//   qemu.pid          QEMU's pid, while it runs
//   suspended.state   the VM's memory and devices, while it is suspended,
//                     compressed to suspended.state.zst (compress.js)

// Where the scripts in vm/scripts keep the VM, unless RUN_DIR says otherwise.
const scriptRunDir = () => process.env.RUN_DIR || vmLayout(vmConfig.vmDataDir).run;

// Saving or loading a few GB of memory takes a while on a busy host.
const STATE_TIMEOUT_MS = 120000;

const localState = async (runDir) => {
  const dir = path.resolve(runDir);
  const pid = await readPid(dir);
  const running = pid !== null && (await host.isAlive(pid, dir));
  const suspended = !running && (await hasSuspendedState(dir));
  return { dir, pid, running, suspended };
};

// Runs QEMU in the foreground from the saved state in `incoming`, continues
// the VM once the state has loaded, and sets its clock. Resolves when QEMU
// exits, and keeps the dir only if the VM was suspended.
const runForeground = async ({ dir, machine, cdpPort, vncPort, incoming, afterContinue = async () => {} }) => {
  const args = buildQemuArgs({
    name: path.basename(dir),
    dir,
    overlay: path.join(dir, 'overlay.qcow2'),
    cdpHostPort: cdpPort,
    vncHostPort: vncPort,
    incoming,
    consoleOnStdio: true,
    ...machine
  });
  consola.info(`QEMU CDP will answer at http://127.0.0.1:${cdpPort}/json/version`, LOG_ATTRIBUTES);
  consola.info(`QEMU and a VNC viewer can show the display at 127.0.0.1:${vncPort}`, LOG_ATTRIBUTES);
  consola.info(
    'QEMU from another terminal, vm/scripts/suspend.js suspends this VM. Press Ctrl-A then X to quit.',
    LOG_ATTRIBUTES
  );

  const child = spawn(ARCHES[machine.arch].binary, args, { stdio: 'inherit' });
  let exited = false;
  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      consola.error(qemu(error.message), LOG_ATTRIBUTES);
      resolve(127);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => {
    exited = true;
  });

  // In the background, since QEMU has the terminal.
  const finishing = (async () => {
    let qmp;
    while (!qmp && !exited) {
      qmp = await openQmp(path.join(dir, 'qmp.sock')).catch(() => host.delay(200));
    }
    if (!qmp) {
      return;
    }
    try {
      await continueIncoming(qmp, STATE_TIMEOUT_MS);
    } finally {
      qmp.close();
    }
    await afterContinue();
    await setGuestClock({ dir, name: path.basename(dir), connectQmp: openQmp });
  })().catch((error) =>
    consola.error(`QEMU unable to continue the VM: ${error instanceof Error ? error.message : error}`, LOG_ATTRIBUTES)
  );

  const code = await exit;
  await Promise.race([finishing, host.delay(1000)]);
  for (const file of ['qemu.pid', 'qmp.sock', 'qga.sock']) {
    await rm(path.join(dir, file), { force: true });
  }
  // vm/scripts/suspend.js may already have compressed the state.
  const { suspended } = await localState(dir);
  if (!suspended) {
    await rm(dir, { recursive: true, force: true });
  }
  return { code, suspended };
};

// Starts a copy of the snapshot, so the browser answers in seconds, as it was
// when the snapshot was saved. Writes go to a copy of the snapshot's disk in
// runDir, so the snapshot stays as it is.
const startFromSnapshot = async ({ snapshotDir, runDir, cdpPort = 9222, vncPort = 5900 }) => {
  const machine = await readSnapshot(snapshotDir);
  if (!machine) {
    throw new Error(`No snapshot in ${snapshotDir}; save one first with vm/build-image.sh`);
  }
  // The snapshot's disk only records its changes to the image, so it fits
  // only the image as it was.
  const status = await snapshotStatus({
    snapshotDir,
    os: machineOs(machine),
    arch: machine.arch,
    memory: machine.memory,
    cpus: machine.cpus
  });
  if (!status.current) {
    throw new Error(`${status.reason}; save a new one with vm/build-image.sh`);
  }
  const { dir, running, suspended } = await localState(runDir);
  if (running) {
    throw new Error(`A VM is already running in ${dir}; quit it first`);
  }
  if (suspended) {
    throw new Error(`A VM is suspended in ${dir}; continue it with vm/scripts/resume.js, or delete it`);
  }
  if (path.join(dir, 'qmp.sock').length > MAX_SOCKET_PATH) {
    throw new Error(`RUN_DIR is too long for the VM's sockets: ${runDir}`);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(path.join(snapshotDir, 'overlay.qcow2'), path.join(dir, 'overlay.qcow2'));
  await writeFile(path.join(dir, 'machine.json'), JSON.stringify(machine));
  await writeFile(path.join(dir, 'cdp-port'), String(cdpPort));
  await writeFile(path.join(dir, 'vnc-port'), String(vncPort));

  if (!ARCHES[machine.arch].vmgenid) {
    consola.warn(
      "QEMU this VM shares the guest kernel's random number state with other copies of the snapshot",
      LOG_ATTRIBUTES
    );
  }
  consola.info(`QEMU starting ${machine.image} from the snapshot in ${snapshotDir}`, LOG_ATTRIBUTES);
  consola.info("QEMU the console continues the snapshot's root shell; press Enter for a prompt.", LOG_ATTRIBUTES);
  return runForeground({
    dir,
    machine,
    cdpPort,
    vncPort,
    incoming: path.join(path.resolve(snapshotDir), 'vm.state')
  });
};

// Saves the running VM to suspended.state, stops QEMU, which frees its
// memory, and compresses the state. resumeLocal continues it where it was.
const suspendLocal = async ({ runDir }) => {
  const { dir, pid, running } = await localState(runDir);
  if (!running || pid === null) {
    throw new Error(`No VM is running in ${dir}`);
  }
  await suspendVm({ dir, connectQmp: openQmp, timeoutMs: STATE_TIMEOUT_MS });
  while (await host.isAlive(pid, dir)) {
    await host.delay(100);
  }
  const compressed = await compressSuspendedState(dir);
  const file = compressed?.file ?? path.join(dir, 'suspended.state');
  const { size } = await stat(file);
  consola.info(
    `QEMU suspended to ${file} (${Math.round(size / 2 ** 20)} MB${compressed ? `, ${(compressed.before / compressed.after).toFixed(2)}:1` : ''})`,
    LOG_ATTRIBUTES
  );
  return { file };
};

// Continues the suspended VM in the foreground: the same machine, disk, and
// ports, from its saved state.
const resumeLocal = async ({ runDir }) => {
  const { dir, running, suspended } = await localState(runDir);
  if (running) {
    throw new Error(`The VM in ${dir} is already running`);
  }
  if (!suspended) {
    throw new Error(`No suspended VM in ${dir}`);
  }
  const machine = JSON.parse(await readFile(path.join(dir, 'machine.json'), 'utf8'));
  await checkImage(machine).catch((error) => {
    throw new Error(`Unable to resume the VM in ${dir}: ${error.message}`, { cause: error });
  });
  const state = await loadableSuspendedState(dir);
  consola.info(`QEMU resuming the VM in ${dir}`, LOG_ATTRIBUTES);
  return runForeground({
    dir,
    machine,
    cdpPort: await readPort(dir, 'cdp-port'),
    vncPort: await readPort(dir, 'vnc-port'),
    incoming: state,
    // The file lags the running VM once it continues, and resuming from it
    // again would rewind the disk under the guest.
    afterContinue: () => removeSuspendedState(dir)
  });
};

export { localState, resumeLocal, scriptRunDir, startFromSnapshot, suspendLocal };
