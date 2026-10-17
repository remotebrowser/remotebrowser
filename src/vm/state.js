import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Each VM keeps its state in <VM_DATA_DIR>/machines/<browser-id>/. QEMU, and
// the logs, call it chromium-<browser-id>.

const BROWSER_VM_PREFIX = 'chromium-';

// Unreserved URL chars only: a browser id is a path segment and must never escape it.
const BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const isWellFormedBrowserId = (browserId) => typeof browserId === 'string' && BROWSER_ID_PATTERN.test(browserId);

const vmName = (browserId) => `${BROWSER_VM_PREFIX}${browserId}`;

const readPid = async (dir) => {
  const pid = Number.parseInt(await readFile(path.join(dir, 'qemu.pid'), 'utf8').catch(() => ''), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

// NaN when the file is missing or holds no number.
const readPort = async (dir, file) => Number.parseInt(await readFile(path.join(dir, file), 'utf8').catch(() => ''), 10);

export { isWellFormedBrowserId, readPid, readPort, vmName };
