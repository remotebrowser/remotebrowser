import { consola } from 'consola/basic';
import { buildVm, buildableOses } from './build.js';
import { OSES } from './os.js';
import { LOG_ATTRIBUTES, step } from './step.js';

// Builds the image and snapshot of each OS, as vm/build-image.sh does, in
// the background of the server. An OS that cannot be built on this host is
// skipped.
// It runs async on the main thread, not in a worker thread: the work is in
// Docker and QEMU, and only the main thread sends logs to OTLP.
//
// The returned promise never rejects; a failure is logged, and the server
// keeps running without a fresh image or snapshot of that OS. It resolves to
// whether every OS it tried is ready.
const bootstrapVm = async ({ build = buildVm, oses = buildableOses } = {}) => {
  const buildable = await oses().catch(() => []);
  for (const os of Object.keys(OSES).filter((os) => !buildable.includes(os))) {
    consola.info(`QEMU skipping ${OSES[os].label}, which cannot be built here`, LOG_ATTRIBUTES);
  }
  const results = await Promise.all(
    buildable.map((os) =>
      step(`Preparing the ${OSES[os].label} image and snapshot`, () => build({ os })).then(
        () => true,
        (error) => {
          consola.error(`QEMU unable to prepare the ${OSES[os].label} image and snapshot`, {
            ...LOG_ATTRIBUTES,
            'rb.vm_os': os,
            'error.type': error instanceof Error ? error.message : String(error)
          });
          return false;
        }
      )
    )
  );
  return results.every(Boolean);
};

export { bootstrapVm };
