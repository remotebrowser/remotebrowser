import { consola } from 'consola/basic';

const LOG_ATTRIBUTES = { 'event.domain': 'qemu' };

// Every VM log line starts with QEMU, so it is easy to find among the others.
// The first word is lowercased unless it is an acronym such as VM or CDP.
const qemu = (text) => `QEMU ${/^[A-Z]{2}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1)}`;

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

// Runs one step of the VM build and logs it before it starts and when it ends,
// with how long it took. Building the image takes minutes and the snapshot
// tens of seconds, so these lines show where the time goes.
const step = async (message, fn) => {
  consola.info(`${qemu(message)}...`, LOG_ATTRIBUTES);
  const started = performance.now();
  try {
    const result = await fn();
    const ms = performance.now() - started;
    consola.info(`${qemu(message)}: done in ${seconds(ms)}`, { ...LOG_ATTRIBUTES, 'rb.duration_ms': Math.round(ms) });
    return result;
  } catch (error) {
    const ms = performance.now() - started;
    consola.error(`${qemu(message)}: failed after ${seconds(ms)}`, {
      ...LOG_ATTRIBUTES,
      'rb.duration_ms': Math.round(ms),
      'error.type': error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export { LOG_ATTRIBUTES, qemu, step };
