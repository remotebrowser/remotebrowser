import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { vmConfig } from './config.js';
import * as host from './host.js';
import { ARCHES, hostArch } from './qemu.js';
import { step } from './step.js';

// Checks the host once at startup, so a missing QEMU fails the server at once,
// not on the first browser launch. The image is not checked: the server builds
// it in the background after this.
const setupQemu = ({ arch = hostArch(), dataDir = vmConfig.vmDataDir, run = host.run } = {}) =>
  step('Setting up', async () => {
    for (const tool of [ARCHES[arch].binary, 'qemu-img']) {
      const { code, stderr } = await run([tool, '--version']);
      if (code !== 0) {
        throw new Error(`${tool} is not available${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      }
    }
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, fsConstants.W_OK);
  });

export { setupQemu };
