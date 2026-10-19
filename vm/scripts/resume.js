#!/usr/bin/env node
// Continues the VM that vm/scripts/suspend.js suspended, in the foreground
// like vm/scripts/run.js: the same machine, disk, and ports, from its saved
// state.
//
//   vm/scripts/resume.js
import { consola } from 'consola/basic';
import { LOG_ATTRIBUTES, qemu } from '../../src/vm/step.js';
import { resumeLocal, scriptRunDir } from '../../src/vm/local.js';

try {
  const { code, suspended } = await resumeLocal({ runDir: scriptRunDir() });
  if (suspended) {
    consola.info('QEMU suspended; vm/scripts/resume.js continues this VM.', LOG_ATTRIBUTES);
  }
  process.exit(code);
} catch (error) {
  consola.error(qemu(error instanceof Error ? error.message : String(error)), LOG_ATTRIBUTES);
  process.exit(1);
}
