import { access, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { consola } from 'consola/basic';
import { osLayout, vmLayout } from './layout.js';
import { imageFiles } from './qemu.js';
import { LOG_ATTRIBUTES } from './step.js';

// Shared image helpers; linux-image.js builds the image itself.

// Size and modification time, which change when a file is built again.
const fileStamp = async (file) => {
  const info = await stat(file);
  return `${info.size} ${Math.trunc(info.mtimeMs / 1000)}`;
};

const exists = (file) =>
  access(file).then(
    () => true,
    () => false
  );

const hasImageFiles = async (image) => {
  for (const file of Object.values(imageFiles(image))) {
    if (!(await exists(file))) {
      return false;
    }
  }
  return true;
};

const readMachine = (dir) =>
  readFile(path.join(dir, 'machine.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
};

// Deletes the builds of `os` that are not `keep`, the current one, and that
// no snapshot or VM runs on, and what builds that stopped halfway left
// behind. `vmDirs` are more dirs of one VM each, such as a RUN_DIR.
const pruneImages = async ({ dataDir, os, keep, vmDirs = [] }) => {
  const { snapshots, machines, run: runDir } = vmLayout(dataDir);
  const { images } = osLayout(dataDir, os);
  const used = new Set(keep ? [path.dirname(path.resolve(keep))] : []);
  const note = (machine) => machine?.image && used.add(path.dirname(path.resolve(machine.image)));
  for (const dir of [runDir, ...vmDirs]) {
    note(await readMachine(dir));
  }
  for (const entry of await readdir(snapshots).catch(() => [])) {
    note(await readMachine(path.join(snapshots, entry)));
  }
  for (const entry of await readdir(machines).catch(() => [])) {
    note(await readMachine(path.join(machines, entry)));
  }
  const removed = [];
  for (const entry of await readdir(images).catch(() => [])) {
    const dir = path.join(images, entry);
    const builder = /^\.tmp-(\d+)$/.exec(entry);
    const unused = builder ? !isAlive(Number(builder[1])) : !used.has(dir);
    if (unused) {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  if (removed.length > 0) {
    consola.info(`QEMU removed ${removed.length} image build(s) that no VM uses`, LOG_ATTRIBUTES);
  }
  return removed;
};

// A VM resumes only on the very image files it started on; on others, its
// disk would no longer match.
const checkImage = async (machine) => {
  for (const file of Object.values(imageFiles(machine.image))) {
    await access(file).catch(() => {
      throw new Error(`its image file ${file} is gone`);
    });
  }
  if (machine.imageStamp && (await fileStamp(machine.image)) !== machine.imageStamp) {
    throw new Error(`its image ${machine.image} has changed since it started`);
  }
};

export { checkImage, fileStamp, hasImageFiles, pruneImages };
