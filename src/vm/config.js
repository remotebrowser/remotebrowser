import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consola } from 'consola/basic';
import { socketPathsFit } from './layout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Apart from src/config.js, so vm/scripts/ run without the app's secrets.
const buildVmConfig = (env) => {
  const errors = [];

  // VM_DATA_DIR holds the image builds, the snapshot, and each VM's disk and
  // pidfile (layout.js), so it must survive an app restart.
  const VM_DATA_DIR = path.resolve(env.VM_DATA_DIR || path.join(__dirname, '..', '..', '.data', 'vm'));
  if (!socketPathsFit(VM_DATA_DIR)) {
    errors.push(`VM_DATA_DIR is too long for the VM's sockets: ${VM_DATA_DIR}`);
  }
  // The same for every OS. Windows needs 4G, and Linux runs on less, but
  // one size keeps the hosts simple to plan.
  const VM_MEMORY = env.VM_MEMORY || '4G';
  if (!/^[1-9][0-9]*[MG]$/.test(VM_MEMORY)) {
    errors.push('VM_MEMORY must be a size in M or G, e.g. 4G');
  }
  const vmCpus = env.VM_CPUS ? Number(env.VM_CPUS) : 2;
  if (!Number.isInteger(vmCpus) || vmCpus < 1) {
    errors.push('VM_CPUS must be a positive integer, e.g. 2');
  }
  // Starting a VM is CPU-heavy. When too many start at once, the host runs out
  // of CPU and they time out before the browser answers. More wait their turn.
  const vmStartConcurrency = env.VM_START_CONCURRENCY ? Number(env.VM_START_CONCURRENCY) : 4;
  if (!Number.isInteger(vmStartConcurrency) || vmStartConcurrency < 1) {
    errors.push('VM_START_CONCURRENCY must be a positive integer, e.g. 4');
  }

  const vmConfig = Object.freeze({
    vmDataDir: VM_DATA_DIR,
    vmMemory: VM_MEMORY,
    vmCpus,
    vmStartConcurrency
  });

  return { vmConfig, errors };
};

const { vmConfig, errors } = buildVmConfig(process.env);
if (errors.length > 0) {
  for (const message of errors) consola.error(message);
  process.exit(1);
}

export { buildVmConfig, vmConfig };
