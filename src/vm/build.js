import { consola } from 'consola/basic';
import { vmConfig } from './config.js';
import { buildImage, imageStatus, pruneImages } from './image.js';
import { vmLayout } from './layout.js';
import { hostArch } from './qemu.js';
import { snapshotStatus, takeSnapshot } from './snapshot.js';
import { LOG_ATTRIBUTES, qemu, step } from './step.js';

// Makes sure the VM image and its snapshot are there and in sync: builds the
// image when there is no build of vm/ as it is now, then saves a new snapshot
// when the one there is missing or out of date. Each step is skipped when its
// result is up to date, so calling this again is cheap.
const buildVm = async ({
  dataDir = vmConfig.vmDataDir,
  runDir = process.env.RUN_DIR,
  memory = vmConfig.vmMemory,
  cpus = vmConfig.vmCpus,
  arch = hostArch()
} = {}) => {
  const { images, snapshot } = vmLayout(dataDir);
  const imageCheck = await step(`Checking the VM image in ${images}`, () => imageStatus({ imagesDir: images, arch }));
  const { image } = imageCheck;
  if (imageCheck.current) {
    consola.info(`QEMU VM image ${image} is up to date`, LOG_ATTRIBUTES);
  } else {
    consola.info(qemu(imageCheck.reason), LOG_ATTRIBUTES);
    await step('Building the VM image', () => buildImage({ image, arch }));
  }

  const machine = { snapshotDir: snapshot, image, arch, memory, cpus };
  const status = await step(`Checking the VM snapshot in ${snapshot}`, () => snapshotStatus(machine));
  if (status.current) {
    consola.info('QEMU VM snapshot is up to date', LOG_ATTRIBUTES);
  } else {
    consola.info(qemu(status.reason), LOG_ATTRIBUTES);
    await step('Saving a new VM snapshot', () => takeSnapshot(machine));
  }
  // Builds of the image that no VM runs on any more.
  await pruneImages({ dataDir, keep: image, vmDirs: runDir ? [runDir] : [] });
};

export { buildVm };
