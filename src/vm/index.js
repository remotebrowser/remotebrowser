import { createVmClient } from './client.js';

// In-process VM manager. It runs every browser as its own QEMU virtual machine:
// a disposable qcow2 overlay on a shared, read-only image, direct kernel boot,
// user-mode networking that forwards only the CDP port, and QEMU's own VNC
// server for the screen, both on host loopback.
//
// Each VM keeps its state in <VM_DATA_DIR>/machines/<browser-id>/. QEMU runs
// detached, with a pidfile there, so browsers outlive an app restart, as they
// did with containers.
//
//   os.js       the guest OS a browser runs on
//   qemu.js     QEMU command line, arch, and accel
//   host.js     processes, ports, and pids on the host
//   qmp.js      QMP and guest agent sessions
//   state.js    browser ids and the per-VM state dir
//   cdp.js      the guest's CDP websocket URL
//   suspend.js  suspend and resume
//   proxy.js    the browser's upstream proxy
//   screen-resolution.js  the browser's screen size
//   screen-scale.js       the browser's screen scale
//   client.js   the VM client that ties these together

// Reassignable so tests (and future callers) can swap the client; importers read
// the live binding at call time.
let vms = createVmClient();
const setVmClient = (client) => {
  vms = client;
};

export { createVmClient } from './client.js';
export { buildQemuArgs, detectAccel, hostArch, imageFiles } from './qemu.js';
export { DEFAULT_OS, OSES, isOs } from './os.js';
export { DEFAULT_SCREEN_RESOLUTION, normalizeScreenResolution } from './screen-resolution.js';
export { DEFAULT_SCREEN_SCALE, normalizeScreenScale } from './screen-scale.js';
export { normalizeProxyUrl, maskProxyUrl } from './proxy.js';
export { openQmp } from './qmp.js';
export { isWellFormedBrowserId } from './state.js';
export { setVmClient, vms };
