import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { consola } from 'consola/basic';
import { vmConfig } from './config.js';
import { generateShortId } from '../id.js';
import { fetchWebSocketDebuggerUrl, rewriteWsUrl } from './cdp.js';
import * as host from './host.js';
import { continueIncoming, setGuestClock } from './incoming.js';
import { osLayout, vmLayout } from './layout.js';
import { DEFAULT_OS, OSES, isOs } from './os.js';
import { ARCHES, buildQemuArgs, detectAccel, hostArch } from './qemu.js';
import {
  DEFAULT_SCREEN_RESOLUTION,
  normalizeScreenResolution,
  vncScreenSize,
  writeGuestScreenResolution
} from './screen-resolution.js';
import { normalizeScreenScale, writeGuestScreenScale } from './screen-scale.js';
import { normalizeProxyUrl, writeGuestProxy } from './proxy.js';
import {
  readAnyScreenshot,
  readScreenshot,
  readSuspendedPreviewImage,
  readSuspendedPreviewList,
  writeScreenshot
} from './previews.js';
import { openQmp } from './qmp.js';
import { readSnapshot, snapshotStatus } from './snapshot.js';
import { isWellFormedBrowserId, readPid, readPort, vmName } from './state.js';
import { createSuspender } from './suspend.js';
import { readVncScreenSize } from './vnc.js';

const { delay, lastLines } = host;

const screenResolutionLabel = (mode) => (mode ? `${mode.width}x${mode.height}` : 'default');
const screenScaleLabel = (scale) => (scale ? `${scale}%` : 'default');

const LAUNCH_ATTEMPTS = 3;
const START_TIMEOUT_MS = 15000;
const STOP_GRACE_MS = 5000;
// Chromium takes a second or two to start, more on a busy host.
const BROWSER_START_TIMEOUT_MS = 30000;
// Saving or loading a few GB of memory takes a while on a busy host.
const SUSPEND_TIMEOUT_MS = 120000;

// Everything host-facing is behind this factory so tests can inject fakes; the
// singleton in index.js is what the app uses.
const createVmClient = ({
  arch = hostArch(),
  accel,
  dataDir = vmConfig.vmDataDir,
  memory = vmConfig.vmMemory,
  cpus = vmConfig.vmCpus,
  start = host.start,
  portOpen = host.portOpen,
  freePort = host.freePort,
  isAlive = host.isAlive,
  kill = host.kill,
  connectQmp = openQmp,
  fetchImpl = globalThis.fetch,
  cdpRetry = { attempts: 10, delayMs: 1000, timeoutMs: 5000 },
  startTimeoutMs = START_TIMEOUT_MS,
  browserStartTimeoutMs = BROWSER_START_TIMEOUT_MS,
  stopGraceMs = STOP_GRACE_MS,
  suspendTimeoutMs = SUSPEND_TIMEOUT_MS,
  zstd = 'zstd',
  readScreenSize = readVncScreenSize
} = {}) => {
  const { binary } = ARCHES[arch];
  const { machines: machinesDir } = vmLayout(dataDir);
  const snapshotDirOf = (os) => osLayout(dataDir, os).snapshot;
  const vmDir = (browserId) => path.join(machinesDir, browserId);
  let accelPromise = accel ? Promise.resolve(accel) : null;
  const getAccel = () => (accelPromise ??= detectAccel());

  // Starts QEMU for the machine in `dir`, booting it or, with `incoming`,
  // loading that saved state, and waits until its CDP port is forwarded.
  // Ports that QEMU cannot bind are retried with fresh ones; the first attempt
  // may ask for the ports the VM had before it was suspended.
  const startVm = async ({ name, dir, machine, incoming, ports }) => {
    const overlay = path.join(dir, 'overlay.qcow2');
    const logFile = path.join(dir, 'qemu.log');
    let lastError = '';
    for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt += 1) {
      const cdpHostPort = attempt === 0 && ports ? ports.cdp : await freePort();
      let vncHostPort = attempt === 0 && ports ? ports.vnc : await freePort();
      while (vncHostPort === cdpHostPort) {
        vncHostPort = await freePort();
      }
      const args = buildQemuArgs({
        name,
        dir,
        overlay,
        incoming,
        cdpHostPort,
        vncHostPort,
        ...machine
      });
      const { pid, exited } = await start([binary, ...args], logFile);
      /** @type {number | null} */
      let exitCode = null;
      void exited.then((code) => {
        exitCode = code;
      });
      const deadline = Date.now() + startTimeoutMs;
      let ready = false;
      while (exitCode === null && Date.now() < deadline) {
        ready = await portOpen(cdpHostPort);
        if (ready) {
          break;
        }
        await delay(100);
      }
      if (ready && exitCode === null) {
        await writeFile(path.join(dir, 'cdp-port'), String(cdpHostPort));
        await writeFile(path.join(dir, 'vnc-port'), String(vncHostPort));
        return { pid, cdpHostPort, vncHostPort };
      }
      if (exitCode === null && pid) {
        kill(pid, 'SIGKILL');
      }
      lastError =
        (await lastLines(logFile)) ||
        (exitCode === null ? `${binary} did not start in time` : `${binary} exited with code ${String(exitCode)}`);
    }
    throw new Error(lastError);
  };

  const waitForExit = async (pid, dir) => {
    const deadline = Date.now() + stopGraceMs;
    while ((await isAlive(pid, dir)) && Date.now() < deadline) {
      await delay(100);
    }
    if (await isAlive(pid, dir)) {
      kill(pid, 'SIGKILL');
    }
  };

  // The snapshot of an OS fits only the machine it was saved from, and only
  // loads under the accelerator it was saved with. If not, says why.
  const usableSnapshot = async (os, vmAccel) => {
    const snapshotDir = snapshotDirOf(os);
    const status = await snapshotStatus({ snapshotDir, os, arch, memory, cpus });
    if (!status.current) {
      return { reason: status.reason };
    }
    const saved = await readSnapshot(snapshotDir);
    if (saved.accel !== vmAccel) {
      return { reason: `The snapshot was saved under ${saved.accel}, but VMs here run under ${vmAccel}` };
    }
    return { saved };
  };

  // Starts the VM as the snapshot left it, with the browser already up, on
  // a copy of the snapshot's disk.
  const startFromSnapshot = async ({ name, dir, os, saved, proxy, screenResolution, screenScale }) => {
    const snapshotDir = snapshotDirOf(os);
    // A reflink where the filesystem has them, else a plain copy.
    await copyFile(
      path.join(snapshotDir, 'overlay.qcow2'),
      path.join(dir, 'overlay.qcow2'),
      fsConstants.COPYFILE_FICLONE
    );
    // The image build, and its stamp, so a resume can check that it is
    // still the same.
    const machine = {
      os,
      arch: saved.arch,
      accel: saved.accel,
      image: saved.image,
      imageStamp: saved.imageStamp,
      memory: saved.memory,
      cpus: saved.cpus
    };
    await writeFile(path.join(dir, 'machine.json'), JSON.stringify(machine));
    const started = await startVm({ name, dir, machine, incoming: path.join(path.resolve(snapshotDir), 'vm.state') });
    try {
      const qmp = await connectQmp(path.join(dir, 'qmp.sock'));
      try {
        await continueIncoming(qmp, suspendTimeoutMs);
      } finally {
        qmp.close();
      }
      // Before the clock, which starts the browser, so its first request
      // already takes this route, and its window fills this screen at this scale.
      if (proxy) {
        await writeGuestProxy({ dir, proxy, connectQmp });
      }
      if (screenResolution) {
        await writeGuestScreenResolution({ dir, screenResolution, connectQmp });
        await waitForScreenResolution(started.vncHostPort, screenResolution);
      }
      if (screenScale) {
        await writeGuestScreenScale({ dir, screenScale, connectQmp });
      }
      // The guest clock stopped when the snapshot was saved. Setting it also
      // starts the browser, which is not in the snapshot (see
      // chromium-start.timer in vm/linux/files).
      await setGuestClock({ dir, name, connectQmp });
      await waitForBrowser(started.cdpHostPort);
    } catch (error) {
      kill(started.pid, 'SIGKILL');
      await waitForExit(started.pid, dir);
      throw error;
    }
    return started;
  };

  // The guest sets the screen size a moment after the host writes it, and a
  // change while it sets one would be missed, so wait until it shows.
  const waitForScreenResolution = async (port, mode) => {
    const { width, height } = vncScreenSize(mode);
    const deadline = Date.now() + browserStartTimeoutMs;
    let seen = 'no answer';
    while (Date.now() < deadline) {
      try {
        const size = await readScreenSize(port, cdpRetry.timeoutMs);
        if (size.width === width && size.height === height) {
          return;
        }
        seen = `${size.width}x${size.height}`;
      } catch (error) {
        seen = error instanceof Error ? error.message : String(error);
      }
      await delay(100);
    }
    throw new Error(`the screen did not change to ${mode.width}x${mode.height} (${seen})`);
  };

  const waitForBrowser = async (port) => {
    const deadline = Date.now() + browserStartTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await fetchWebSocketDebuggerUrl(fetchImpl, `http://127.0.0.1:${port}`, cdpRetry.timeoutMs);
        return;
      } catch (error) {
        lastError = error;
        await delay(200);
      }
    }
    throw new Error(
      `the browser did not start; it starts when the guest clock is set (${lastError instanceof Error ? lastError.message : 'no answer'})`
    );
  };

  // The OSes with a usable snapshot, which new browsers can run on. The
  // server saves the snapshots in the background at startup.
  const launchableOses = async () => {
    const vmAccel = await getAccel();
    const oses = [];
    for (const os of Object.keys(OSES)) {
      if ((await usableSnapshot(os, vmAccel)).saved) {
        oses.push(os);
      }
    }
    return oses;
  };

  // Lets the app refuse a launch up front, when `os`, or every OS, has no
  // usable snapshot.
  const canLaunchBrowser = async (os) =>
    os ? isOs(os) && Boolean((await usableSnapshot(os, await getAccel())).saved) : (await launchableOses()).length > 0;

  // `os` is the guest OS; see os.js.
  // `proxy` is an upstream proxy URL for the browser's traffic; see proxy.js.
  // `screenResolution` is the screen size; see screen-resolution.js.
  // `screenScale` is the screen scale in percent; see screen-scale.js.
  const launchBrowser = async ({ os = DEFAULT_OS, proxy = null, screenResolution = null, screenScale = null } = {}) => {
    if (!isOs(os)) {
      throw new Error(`Unknown OS ${os}`);
    }
    // A bad URL, screen resolution, or scale fails here, before a VM starts.
    const upstreamProxy = normalizeProxyUrl(proxy);
    const resolution = normalizeScreenResolution(screenResolution);
    const scale = normalizeScreenScale(screenScale);
    const browserId = generateShortId('Q', 8);
    const name = vmName(browserId);
    const dir = vmDir(browserId);
    const vmAccel = await getAccel();
    // New VMs start only from the snapshot, never by booting the image: the
    // snapshot has the browser already up, and the app does not wait for a
    // boot. The server saves one at startup (src/vm/bootstrap.js).
    const { saved, reason } = await usableSnapshot(os, vmAccel);
    if (!saved) {
      consola.error(`QEMU unable to start browser VM ${name}: no usable snapshot`, {
        'event.domain': 'qemu',
        'rb.runtime': 'qemu',
        'rb.vm_os': os,
        'rb.vm_snapshot_dir': snapshotDirOf(os),
        'error.type': reason
      });
      throw new Error(
        `Unable to launch the browser for ${name}: ${reason}; the server saves a snapshot at startup, or run vm/build-${os}.sh`
      );
    }
    // Only the app's user may read the overlay, which holds the browser profile.
    await mkdir(machinesDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    consola.info(`QEMU starting browser VM ${name}`, {
      'event.domain': 'qemu',
      'rb.runtime': 'qemu',
      'rb.accel': vmAccel,
      'rb.vm_os': os,
      'rb.vm_image': saved.image,
      'rb.vm_snapshot_dir': snapshotDirOf(os)
    });
    try {
      const started = await startFromSnapshot({
        name,
        dir,
        os,
        saved,
        proxy: upstreamProxy,
        screenResolution: resolution,
        screenScale: scale
      });
      consola.log(`QEMU started browser VM ${name}`, {
        'event.domain': 'qemu',
        'rb.runtime': 'qemu',
        'rb.cdp_port': started.cdpHostPort,
        'rb.vnc_port': started.vncHostPort,
        'rb.upstream_proxy': Boolean(upstreamProxy),
        'rb.screen_resolution': screenResolutionLabel(resolution),
        'rb.screen_scale': screenScaleLabel(scale)
      });
      return { browserId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consola.error(`QEMU unable to start browser VM ${name}`, {
        'event.domain': 'qemu',
        'rb.runtime': 'qemu',
        'rb.vm_image': saved.image,
        'error.type': message
      });
      await rm(dir, { recursive: true, force: true });
      throw new Error(`Unable to launch the browser for ${name}: ${message}`, { cause: error });
    }
  };

  const browserExists = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return false;
    }
    return stat(vmDir(browserId)).then(
      (info) => info.isDirectory(),
      () => false
    );
  };

  const browserIsRunning = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return false;
    }
    const dir = vmDir(browserId);
    const pid = await readPid(dir);
    return pid !== null && isAlive(pid, dir);
  };

  // Ends QEMU, then removes the overlay, so nothing of the session survives.
  const stopBrowser = async (browserId) => {
    const dir = vmDir(browserId);
    const pid = await readPid(dir);
    if (pid !== null && (await isAlive(pid, dir))) {
      kill(pid, 'SIGTERM');
      await waitForExit(pid, dir);
    }
    await rm(dir, { recursive: true, force: true });
  };

  // The guest keeps the upstream proxy on its disk, so it stays across a
  // suspend and resume. Null means direct.
  const applyProxy = async (browserId, upstreamProxy) => {
    const name = vmName(browserId);
    if (!(await browserIsRunning(browserId))) {
      throw new Error(`${name} is not running`);
    }
    await writeGuestProxy({ dir: vmDir(browserId), proxy: upstreamProxy, connectQmp });
    // Never the URL itself, which may hold a password.
    consola.log(`QEMU ${upstreamProxy ? 'set' : 'cleared'} the upstream proxy of browser VM ${name}`, {
      'event.domain': 'qemu',
      'rb.runtime': 'qemu',
      'rb.upstream_proxy': Boolean(upstreamProxy)
    });
  };

  // Sends a running browser's traffic through `proxy`, a URL as in proxy.js.
  const setProxy = async (browserId, proxy) => {
    if (!isWellFormedBrowserId(browserId)) {
      throw new Error('Invalid browser id');
    }
    const upstreamProxy = normalizeProxyUrl(proxy);
    // Going direct by mistake, e.g. with an empty form field, could reveal the
    // real IP address, so that takes clearProxy.
    if (!upstreamProxy) {
      throw new Error('The proxy URL is empty; clear the proxy instead to connect directly');
    }
    await applyProxy(browserId, upstreamProxy);
  };

  // Lets a running browser connect directly again.
  const clearProxy = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      throw new Error('Invalid browser id');
    }
    await applyProxy(browserId, null);
  };

  const { browserIsSuspended, suspendBrowser, resumeBrowser } = createSuspender({
    vmDir,
    isAlive,
    kill,
    connectQmp,
    startVm,
    waitForExit,
    browserIsRunning,
    suspendTimeoutMs,
    zstd
  });

  // The pages a suspended browser had, with a picture of each (previews.js).
  const listSuspendedPreviews = async (browserId) =>
    isWellFormedBrowserId(browserId) ? readSuspendedPreviewList(vmDir(browserId)) : [];

  const readSuspendedPreview = async (browserId, pageId) =>
    isWellFormedBrowserId(browserId) ? readSuspendedPreviewImage(vmDir(browserId), pageId) : null;

  // Frames can come faster than the disk takes them, so one write runs per
  // page and only the newest waiting frame is written after it.
  /** @type {Map<string, {next: Buffer | null}>} */
  const screenshotWrites = new Map();

  const saveScreenshot = async (browserId, pageId, jpeg) => {
    if (!isWellFormedBrowserId(browserId)) {
      return;
    }
    const key = `${browserId}:${pageId}`;
    const running = screenshotWrites.get(key);
    if (running) {
      running.next = jpeg;
      return;
    }
    const write = { next: jpeg };
    screenshotWrites.set(key, write);
    try {
      while (write.next) {
        const data = write.next;
        write.next = null;
        await writeScreenshot(vmDir(browserId), pageId, data).catch(() => {});
      }
    } finally {
      screenshotWrites.delete(key);
    }
  };

  const readSavedScreenshot = async (browserId, pageId) =>
    isWellFormedBrowserId(browserId) ? readScreenshot(vmDir(browserId), pageId) : null;

  const readAnySavedScreenshot = async (browserId) =>
    isWellFormedBrowserId(browserId) ? readAnyScreenshot(vmDir(browserId)) : null;

  // The guest needs a moment to boot before /json/version answers, so the
  // lookup is retried; the last failure is what surfaces.
  const resolveCdpUrl = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return null;
    }
    let lastError;
    for (let attempt = 0; attempt < cdpRetry.attempts; attempt += 1) {
      try {
        const port = await readPort(vmDir(browserId), 'cdp-port');
        if (!Number.isInteger(port)) {
          throw new Error(`CDP port not found for ${vmName(browserId)}`);
        }
        const baseUrl = `http://127.0.0.1:${port}`;
        return rewriteWsUrl(await fetchWebSocketDebuggerUrl(fetchImpl, baseUrl, cdpRetry.timeoutMs), baseUrl);
      } catch (error) {
        lastError = error;
        if (attempt < cdpRetry.attempts - 1) {
          await delay(cdpRetry.delayMs);
        }
      }
    }
    throw lastError;
  };

  // Sets a running browser's screen size, or the image's default for null.
  // The browser keeps running, and the window manager keeps its window
  // maximized on the new screen.
  const setScreenResolution = async (browserId, screenResolution) => {
    if (!isWellFormedBrowserId(browserId)) {
      throw new Error('Invalid browser id');
    }
    const resolution = normalizeScreenResolution(screenResolution);
    const name = vmName(browserId);
    const dir = vmDir(browserId);
    if (!(await browserIsRunning(browserId))) {
      throw new Error(`${name} is not running`);
    }
    const vncPort = await readPort(dir, 'vnc-port');
    if (!Number.isInteger(vncPort)) {
      throw new Error(`VNC port not found for ${name}`);
    }
    await writeGuestScreenResolution({ dir, screenResolution: resolution, connectQmp });
    await waitForScreenResolution(vncPort, resolution ?? DEFAULT_SCREEN_RESOLUTION);
    consola.log(`QEMU set the screen resolution of browser VM ${name}`, {
      'event.domain': 'qemu',
      'rb.runtime': 'qemu',
      'rb.screen_resolution': screenResolutionLabel(resolution)
    });
  };

  // Sets a running browser's screen scale in percent, or the image's default
  // for null. The browser keeps running, and follows the new scale a moment
  // after this returns: unlike the screen size, nothing outside the guest
  // shows it.
  const setScreenScale = async (browserId, screenScale) => {
    if (!isWellFormedBrowserId(browserId)) {
      throw new Error('Invalid browser id');
    }
    const scale = normalizeScreenScale(screenScale);
    const name = vmName(browserId);
    const dir = vmDir(browserId);
    if (!(await browserIsRunning(browserId))) {
      throw new Error(`${name} is not running`);
    }
    await writeGuestScreenScale({ dir, screenScale: scale, connectQmp });
    consola.log(`QEMU set the screen scale of browser VM ${name}`, {
      'event.domain': 'qemu',
      'rb.runtime': 'qemu',
      'rb.screen_scale': screenScaleLabel(scale)
    });
  };

  return {
    runtime: 'qemu',
    arch,
    getAccel,
    launchableOses,
    canLaunchBrowser,
    launchBrowser,
    browserExists,
    browserIsRunning,
    browserIsSuspended,
    stopBrowser,
    suspendBrowser,
    resumeBrowser,
    listSuspendedPreviews,
    readSuspendedPreview,
    saveScreenshot,
    readSavedScreenshot,
    readAnySavedScreenshot,
    setProxy,
    clearProxy,
    setScreenResolution,
    setScreenScale,
    resolveCdpUrl
  };
};

export { createVmClient };
