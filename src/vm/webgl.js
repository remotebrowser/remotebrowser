import { writeGuestFile } from './guest-file.js';

// The VM has no GPU, so Chromium would render WebGL with Mesa's llvmpipe on
// the CPU, which its GPU blocklist refuses. To enable WebGL, the host writes
// the flag that ignores the blocklist into this guest file through the guest
// agent, and chromium.service in vm/linux/files reads it when it starts.
const GUEST_WEBGL_FILE = '/etc/remotebrowser/webgl.env';
const WEBGL_FLAGS = 'WEBGL_FLAGS=--ignore-gpu-blocklist';

/**
 * Enables WebGL in the guest. It works only before the browser starts.
 * @param {{dir: string, connectQmp: Function, attempts?: number}} params
 */
const writeGuestWebgl = async ({ dir, connectQmp, attempts = 20 }) => {
  try {
    await writeGuestFile({
      dir,
      file: GUEST_WEBGL_FILE,
      content: Buffer.from(`${WEBGL_FLAGS}\n`),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(`unable to enable WebGL: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
};

export { GUEST_WEBGL_FILE, writeGuestWebgl };
