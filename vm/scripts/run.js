#!/usr/bin/env node
// Starts a copy of the snapshot that vm/scripts/build.js saved, to test the
// browser VM without the app. The browser answers in a few seconds, as it was
// when the snapshot was saved. The guest console is this terminal, with a root
// shell; press Ctrl-A then X to quit QEMU.
//
//   vm/scripts/run.js
//
// CDP is forwarded to 127.0.0.1:$CDP_PORT (default 9222), and the display to
// a VNC viewer at 127.0.0.1:$VNC_PORT (default 5900). Writes go to a copy of
// the snapshot's disk in $RUN_DIR (default $VM_DATA_DIR/run), so the snapshot
// stays as it is. The copy is deleted when QEMU exits, unless
// vm/scripts/suspend.js suspended the VM. The snapshot is in
// $VM_DATA_DIR/snapshot, as for the app.
import { consola } from 'consola/basic';
import { LOG_ATTRIBUTES, qemu } from '../../src/vm/step.js';
import { config } from '../../src/config.js';
import { vmLayout } from '../../src/vm/layout.js';
import { scriptRunDir, startFromSnapshot } from '../../src/vm/local.js';

const port = (value, fallback) => (value ? Number(value) : fallback);

try {
  const { code, suspended } = await startFromSnapshot({
    snapshotDir: vmLayout(config.vmDataDir).snapshot,
    runDir: scriptRunDir(),
    cdpPort: port(process.env.CDP_PORT, 9222),
    vncPort: port(process.env.VNC_PORT, 5900)
  });
  if (suspended) {
    consola.info('QEMU suspended; vm/scripts/resume.js continues this VM.', LOG_ATTRIBUTES);
  }
  process.exit(code);
} catch (error) {
  consola.error(qemu(error instanceof Error ? error.message : String(error)), LOG_ATTRIBUTES);
  process.exit(1);
}
