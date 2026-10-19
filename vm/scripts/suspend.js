#!/usr/bin/env node
// Suspends the VM that vm/scripts/run.js started: saves its memory and
// devices to $RUN_DIR/suspended.state, then stops QEMU, which frees the VM's
// memory, and compresses the state with zstd to suspended.state.zst, about a
// quarter of the size. The disk stays, and vm/scripts/resume.js continues the
// VM where it was. As in the app, see src/vm/compress.js.
//
//   vm/scripts/suspend.js
import { consola } from 'consola/basic';
import { LOG_ATTRIBUTES, qemu } from '../../src/vm/step.js';
import { scriptRunDir, suspendLocal } from '../../src/vm/local.js';

try {
  await suspendLocal({ runDir: scriptRunDir() });
} catch (error) {
  consola.error(qemu(error instanceof Error ? error.message : String(error)), LOG_ATTRIBUTES);
  process.exitCode = 1;
}
