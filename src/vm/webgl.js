import { writeGuestFile } from './guest-file.js';

// The VM has no GPU, so Chromium would render WebGL with Mesa's llvmpipe on
// the CPU, which its GPU blocklist refuses. To enable WebGL, the host writes
// the flag that ignores the blocklist into this guest file through the guest
// agent, and chromium.service in vm/linux/files reads it when it starts.
// Windows has no GPU either, and browser.ps1 in vm/windows-11 passes the
// same flag to Edge when this file is there.
const GUEST_WEBGL_FILE = '/etc/remotebrowser/webgl.env';
const WINDOWS_WEBGL_FILE = 'C:\\ProgramData\\remotebrowser\\webgl';
const WEBGL_FLAGS = 'WEBGL_FLAGS=--ignore-gpu-blocklist';

/**
 * Enables WebGL in the guest. It works only before the browser starts.
 * @param {{dir: string, connectQmp: Function, guest?: string, attempts?: number}} params
 */
const writeGuestWebgl = async ({ dir, connectQmp, guest = 'linux', attempts = 20 }) => {
  try {
    await writeGuestFile({
      dir,
      file: guest === 'windows' ? WINDOWS_WEBGL_FILE : GUEST_WEBGL_FILE,
      content: Buffer.from(guest === 'windows' ? 'on\n' : `${WEBGL_FLAGS}\n`),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(`unable to enable WebGL: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
};

export { GUEST_WEBGL_FILE, WINDOWS_WEBGL_FILE, writeGuestWebgl };
