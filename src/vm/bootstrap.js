import { consola } from 'consola/basic';
import { buildVm } from './build.js';
import { LOG_ATTRIBUTES, step } from './step.js';

// Makes sure the VM image and its snapshot are there and up to date, as
// vm/scripts/build.js does, in the background of the server. It runs async on
// the main thread, not in a worker thread: the work is in Docker and QEMU, and
// only the main thread sends logs to OTLP.
//
// The returned promise never rejects; a failure is logged, and the server
// keeps running without a fresh image or snapshot.
const bootstrapVm = ({ build = buildVm } = {}) =>
  step('Preparing the browser VM image and snapshot', () => build()).then(
    () => true,
    (error) => {
      consola.error('QEMU unable to prepare the browser VM image and snapshot', {
        ...LOG_ATTRIBUTES,
        'error.type': error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  );

export { bootstrapVm };
