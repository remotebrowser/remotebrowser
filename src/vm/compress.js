import { access, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { consola } from 'consola/basic';
import { run } from './host.js';
import { step } from './step.js';

// A suspended VM's saved state is a few hundred MB of memory, which zstd
// shrinks to about a quarter. Level 3, zstd's default, on one thread: about 2s
// for 800 MB. Higher levels take two to three times as long for 4-7% less,
// and more threads take cores from the other VMs on the host.
const ZSTD_ARGS = ['-3', '-T1', '-q', '-f'];

const sizeOf = (file) => stat(file).then(({ size }) => size);

const mib = (bytes) => `${(bytes / 2 ** 20).toFixed(0)} MB`;

const zstd = async (args, binary) => {
  const { code, stderr } = await run([binary, ...args]);
  if (code !== 0) {
    throw new Error(
      code === 127 ? `${binary} is not installed` : stderr.trim() || `${binary} exited with code ${code}`
    );
  }
};

// Compresses `file` to `file.zst`. With --rm, zstd removes the original only
// once the compressed file is complete, so a failed or interrupted run leaves
// it as it was.
const compressFile = async (file, { binary = 'zstd' } = {}) => {
  const compressed = `${file}.zst`;
  const partial = `${compressed}.part`;
  const before = await sizeOf(file);
  await step(`Compressing ${file} (${mib(before)})`, async () => {
    try {
      await zstd([...ZSTD_ARGS, '--rm', '-o', partial, file], binary);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    await rename(partial, compressed);
  });
  const after = await sizeOf(compressed);
  return { file: compressed, before, after };
};

// The other way round: `file.zst` back to `file`, then the compressed one
// is removed.
const decompressFile = async (compressed, { binary = 'zstd' } = {}) => {
  const file = compressed.replace(/\.zst$/, '');
  const partial = `${file}.part`;
  await step(`Decompressing ${compressed}`, async () => {
    try {
      await zstd(['-d', '-q', '-f', '--rm', '-o', partial, compressed], binary);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    await rename(partial, file);
  });
  return { file };
};

// A suspended VM keeps its saved memory and devices in its dir, in one of
// these: as QEMU wrote it, or compressed. QEMU loads only the first.
const STATE = 'suspended.state';

const exists = (file) =>
  access(file).then(
    () => true,
    () => false
  );

const hasSuspendedState = async (dir) =>
  (await exists(path.join(dir, STATE))) || (await exists(path.join(dir, `${STATE}.zst`)));

// Compresses the state of a VM that was just suspended. The VM is saved and
// stopped by then either way, so a failure, e.g. no zstd, only keeps the state
// uncompressed, and is logged rather than thrown.
const compressSuspendedState = async (dir, { binary = 'zstd' } = {}) => {
  try {
    return await compressFile(path.join(dir, STATE), { binary });
  } catch (error) {
    consola.warn(`QEMU unable to compress the suspended state in ${dir}; it stays uncompressed`, {
      'event.domain': 'qemu',
      'error.type': error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

// The state as QEMU can load it, decompressed first if need be.
const loadableSuspendedState = async (dir, { binary = 'zstd' } = {}) => {
  const state = path.join(dir, STATE);
  if (!(await exists(state))) {
    await decompressFile(`${state}.zst`, { binary });
  }
  return state;
};

// Once the VM runs on, its saved state lags it, and resuming from it again
// would rewind the disk under the guest.
const removeSuspendedState = async (dir) => {
  await rm(path.join(dir, STATE), { force: true });
  await rm(path.join(dir, `${STATE}.zst`), { force: true });
};

export {
  compressFile,
  compressSuspendedState,
  decompressFile,
  hasSuspendedState,
  loadableSuspendedState,
  removeSuspendedState
};
