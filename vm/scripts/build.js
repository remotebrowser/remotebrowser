#!/usr/bin/env node
// Builds the Debian 13 image, then boots it once and saves the running
// VM as a snapshot, which vm/scripts/run.js starts in seconds. Each step runs
// only when its result is missing or out of date, so running this again is
// cheap. vm/build-debian-13.sh runs this, and vm/build-image.sh runs that.
//
//   vm/scripts/build.js debian-13
//
// It reads the same settings as the app:
//
//   VM_DATA_DIR   where the image goes, in images/<os>/, and the snapshot,
//                 in snapshots/<os>/ (default .data/vm). Delete a build in
//                 images/<os>/ to build it again.
//   VM_MEMORY     the VM's memory (default 2G);
//                 the snapshot holds it, so it takes about this much disk
//                 space
//   VM_CPUS       the VM's CPUs (default 2)
//
// The snapshot is saved again when the image changes, or when VM_MEMORY or
// VM_CPUS change. Building the image needs Docker; the snapshot needs QEMU.
import { consola } from 'consola/basic';
import { LOG_ATTRIBUTES, qemu } from '../../src/vm/step.js';
import { buildVm } from '../../src/vm/build.js';
import { OSES } from '../../src/vm/os.js';

const os = process.argv[2];

try {
  if (!os) {
    throw new Error(`Name the OS to build: ${Object.keys(OSES).join(', ')}`);
  }
  await buildVm({ os });
  consola.success(`QEMU ${OSES[os].label} ready; start a VM with vm/scripts/run.js ${os}`, LOG_ATTRIBUTES);
} catch (error) {
  consola.error(qemu(error instanceof Error ? error.message : String(error)), LOG_ATTRIBUTES);
  process.exitCode = 1;
}
