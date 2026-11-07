import { writeGuestFile } from './guest-file.js';

// The VM has no GPU, so the browser renders WebGL with Mesa's llvmpipe on the
// CPU, which its GPU blocklist refuses. To enable WebGL on Linux without
// --ignore-gpu-blocklist, the host writes this Mesa config through the guest
// agent, before the browser starts, so the blocklist lets WebGL through.
// Windows has no GPU either, and browser.ps1 in vm/windows-11 passes
// --ignore-gpu-blocklist to Edge when its file is there.
const GUEST_WEBGL_FILE = '/etc/drirc';
const WINDOWS_WEBGL_FILE = 'C:\\ProgramData\\remotebrowser\\webgl';
const GL_VENDOR = 'Intel';
const GL_RENDERER = 'Mesa Intel(R) HD Graphics 4400 (HSW GT2)';
const DRIRC = `<driconf>
  <device>
    <application name="Default">
      <option name="force_gl_vendor" value="${GL_VENDOR}"/>
      <option name="force_gl_renderer" value="${GL_RENDERER}"/>
    </application>
  </device>
</driconf>
`;

/**
 * Enables WebGL in the guest. It works only before the browser starts.
 * @param {{dir: string, connectQmp: Function, guest?: string, attempts?: number}} params
 */
const writeGuestWebgl = async ({ dir, connectQmp, guest = 'linux', attempts = 20 }) => {
  try {
    await writeGuestFile({
      dir,
      file: guest === 'windows' ? WINDOWS_WEBGL_FILE : GUEST_WEBGL_FILE,
      content: Buffer.from(guest === 'windows' ? 'on\n' : DRIRC),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(`unable to enable WebGL: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
};

export { DRIRC, GL_RENDERER, GL_VENDOR, GUEST_WEBGL_FILE, WINDOWS_WEBGL_FILE, writeGuestWebgl };
