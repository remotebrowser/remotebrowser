import { consola } from 'consola/basic';
import { vmConfig } from './config.js';
import { pruneImages } from './image.js';
import { osLayout } from './layout.js';
import { linuxImage } from './linux-image.js';
import { OSES, isOs } from './os.js';
import { hostArch } from './qemu.js';
import { snapshotStatus, takeSnapshot } from './snapshot.js';
import { LOG_ATTRIBUTES, qemu, step } from './step.js';

// How each OS's image is made. `missingSource` says why the image cannot be
// built on this host, or null. `prepareSource` downloads what it can.
const BUILDERS = {
  'debian-13': linuxImage('debian-13'),
  'ubuntu-26.04': linuxImage('ubuntu-26.04')
};

// The OSes whose image can be built here.
const buildableOses = async ({ arch = hostArch() } = {}) => {
  const oses = [];
  for (const os of Object.keys(OSES)) {
    if (!(await BUILDERS[os].missingSource({ arch }))) {
      oses.push(os);
    }
  }
  return oses;
};

// Makes sure the image of `os` and its snapshot are there and in sync:
// builds the image when there is no build of its sources as they are now,
// then saves a new snapshot when the one there is missing or out of date.
// Each step is skipped when its result is up to date, so calling this again
// is cheap.
const buildVm = async ({
  os,
  dataDir = vmConfig.vmDataDir,
  runDir = process.env.RUN_DIR,
  memory = vmConfig.vmMemory,
  cpus = vmConfig.vmCpus,
  arch = hostArch()
}) => {
  if (!isOs(os)) {
    throw new Error(`Unknown OS ${os}; pick one of ${Object.keys(OSES).join(', ')}`);
  }
  const { label } = OSES[os];
  const builder = BUILDERS[os];
  const { images, snapshot } = osLayout(dataDir, os);
  const missing = await builder.missingSource({ arch });
  if (missing) {
    throw new Error(missing);
  }
  await builder.prepareSource();
  const imageCheck = await step(`Checking the ${label} image in ${images}`, () =>
    builder.imageStatus({ imagesDir: images, arch })
  );
  const { image } = imageCheck;
  if (imageCheck.current) {
    consola.info(`QEMU ${label} image ${image} is up to date`, LOG_ATTRIBUTES);
  } else {
    consola.info(qemu(imageCheck.reason), LOG_ATTRIBUTES);
    await step(`Building the ${label} image`, () => builder.buildImage({ image, arch, memory, cpus }));
  }

  const machine = { snapshotDir: snapshot, image, os, arch, memory, cpus };
  const status = await step(`Checking the ${label} snapshot in ${snapshot}`, () => snapshotStatus(machine));
  if (status.current) {
    consola.info(`QEMU ${label} snapshot is up to date`, LOG_ATTRIBUTES);
  } else {
    consola.info(qemu(status.reason), LOG_ATTRIBUTES);
    await step(`Saving a new ${label} snapshot`, () => takeSnapshot(machine));
  }
  // Builds of the image that no VM runs on any more.
  await pruneImages({ dataDir, os, keep: image, vmDirs: runDir ? [runDir] : [] });
};

export { buildVm, buildableOses };
