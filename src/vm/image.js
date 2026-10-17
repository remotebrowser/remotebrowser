import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consola } from 'consola/basic';
import { run } from './host.js';
import { vmLayout } from './layout.js';
import { imageFiles } from './qemu.js';
import { LOG_ATTRIBUTES, step } from './step.js';

// The Docker build context: vm/Dockerfile and the files it copies in.
const VM_SOURCE_DIR = fileURLToPath(new URL('../../vm', import.meta.url));

// Size and modification time, which change when a file is built again.
const fileStamp = async (file) => {
  const info = await stat(file);
  return `${info.size} ${Math.trunc(info.mtimeMs / 1000)}`;
};

// What the image is built from. A change to any of these files means the
// image must be built again.
const sourceFiles = async () => {
  const files = ['Dockerfile'];
  for (const entry of await readdir(path.join(VM_SOURCE_DIR, 'files'), { recursive: true })) {
    const relative = path.join('files', entry);
    if ((await stat(path.join(VM_SOURCE_DIR, relative))).isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
};

// A hash of the names, contents, and exec bits of the image's source files.
const imageSourceHash = async () => {
  const hash = createHash('sha256');
  for (const file of await sourceFiles()) {
    const full = path.join(VM_SOURCE_DIR, file);
    const executable = ((await stat(full)).mode & 0o111) !== 0;
    hash.update(`${file}\0${executable ? 'x' : '-'}\0`);
    hash.update(await readFile(full));
    hash.update('\0');
  }
  return hash.digest('hex');
};

// Each build of the image has its own dir, named after its sources, and
// stays as it is once written. A VM's disk only records its changes to the
// image, so it needs the exact build it started on, for as long as it
// exists, suspended or not.
const buildDir = (imagesDir, arch, source) => path.join(imagesDir, `${arch}-${source.slice(0, 16)}`);
const imageIn = (dir) => path.join(dir, 'chromium.qcow2');

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

// The newest complete build for this arch, or null.
const latestImage = async (imagesDir, arch) => {
  const builds = [];
  for (const entry of await readdir(imagesDir).catch(() => [])) {
    const image = imageIn(path.join(imagesDir, entry));
    if (entry.startsWith(`${arch}-`) && (await hasImageFiles(image))) {
      builds.push({ image, mtime: (await stat(image)).mtimeMs });
    }
  }
  return builds.sort((a, b) => b.mtime - a.mtime)[0]?.image ?? null;
};

// The build that fits vm/ as it is now, and whether it is there yet.
const imageStatus = async ({ imagesDir, arch }) => {
  const image = imageIn(buildDir(imagesDir, arch, await imageSourceHash()));
  if (await hasImageFiles(image)) {
    return { image, current: true };
  }
  return { image, current: false, reason: 'No VM image built from vm/Dockerfile and vm/files as they are now' };
};

// Runs a command with its output on ours, since a build takes minutes and
// its progress is what shows that it works.
const runVisible = (argv, { stdin = 'ignore' } = {}) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: [stdin, 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${argv[0]} ${argv[1]} exited with code ${code}`))
    );
  });
  return { child, done };
};

// Unpacks the Docker image and formats it as root in a helper container, so
// file owners and modes in the rootfs survive without root on the host. It
// gets the rootfs on stdin and sends the image files back on stdout, not
// through a bind mount: when the app runs in a container, the Docker daemon
// would mount the host's path, not the app's.
const UNPACK_SCRIPT = `
  exec 3>&1 >&2
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends e2fsprogs qemu-utils >/dev/null
  mkdir /rootfs /out
  tar -x -C /rootfs -f -
  rm -f /rootfs/.dockerenv
  # Docker manages these during the build; set what the VM needs.
  printf "nameserver 10.0.2.3\\n" >/rootfs/etc/resolv.conf
  printf "browser\\n" >/rootfs/etc/hostname
  printf "127.0.0.1 localhost browser\\n::1 localhost\\n" >/rootfs/etc/hosts
  cp "$(ls /rootfs/boot/vmlinuz-* | sort -V | tail -n 1)" "/out/$NAME.kernel"
  cp "$(ls /rootfs/boot/initrd.img-* | sort -V | tail -n 1)" "/out/$NAME.initrd"
  # Headroom for the browser profile and caches; the overlay only grows as used.
  size=$(( $(du -sm /rootfs | cut -f1) * 3 / 2 + 2048 ))
  mke2fs -q -t ext4 -L rootfs -d /rootfs /tmp/rootfs.ext4 "\${size}M"
  # Each copy is a few GB; drop the previous one as soon as it is used up.
  rm -rf /rootfs
  qemu-img convert -c -f raw -O qcow2 /tmp/rootfs.ext4 "/out/$NAME.qcow2"
  rm /tmp/rootfs.ext4
  # The kernel may be 0600; the app user must read all three.
  chmod 0644 "/out/$NAME".*
  tar -C /out -c -f - . >&3
`;

// Exports the container's files and turns them into the image files in out/.
const unpack = async ({ cid, out, name }) => {
  const steps = [
    ['docker', 'export', cid],
    [
      'docker',
      'run',
      '--rm',
      '-i',
      '-e',
      `NAME=${name}`,
      'docker.io/library/debian:trixie-slim',
      'sh',
      '-euc',
      UNPACK_SCRIPT
    ],
    // Owned by the app's user, not by root as in the helper.
    ['tar', '-x', '--no-same-owner', '-C', out, '-f', '-']
  ];
  const children = steps.map((argv, i) =>
    spawn(argv[0], argv.slice(1), {
      stdio: [i === 0 ? 'ignore' : 'pipe', i === steps.length - 1 ? 'inherit' : 'pipe', 'inherit']
    })
  );
  for (let i = 1; i < children.length; i++) {
    // A step that fails early closes its stdin; its exit code tells why.
    children[i].stdin?.on('error', () => {});
    children[i - 1].stdout?.pipe(/** @type {NodeJS.WritableStream} */ (children[i].stdin));
  }
  const codes = await Promise.all(children.map((child) => once(child, 'close')));
  const failed = codes.findIndex(([code]) => code !== 0);
  if (failed !== -1) {
    throw new Error(`${steps[failed].slice(0, 2).join(' ')} exited with code ${codes[failed][0]}`);
  }
};

// Builds the image from vm/Dockerfile into the build dir of `image`, as
// imageStatus names it. Docker is needed only here, not to run the VMs. The
// image is for the host's architecture, since only that one runs with KVM or HVF.
// It is written to a temporary dir and renamed, so a build that stops
// halfway leaves no build dir behind.
const buildImage = async ({ image, arch }) => {
  const info = await run(['docker', 'info']);
  if (info.code !== 0) {
    throw new Error("Docker does not work here, so the VM image cannot be built; 'docker info' shows why");
  }
  const dir = path.dirname(path.resolve(image));
  const temp = path.join(path.dirname(dir), `.tmp-${process.pid}`);
  const name = path.basename(image, '.qcow2');
  const tag = `remotebrowser-vm:${arch}`;
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });

  try {
    await step(
      `Building the Docker image ${tag} from vm/Dockerfile`,
      () => runVisible(['docker', 'build', '-t', tag, VM_SOURCE_DIR]).done
    );
    const created = await run(['docker', 'create', tag]);
    if (created.code !== 0) {
      throw new Error(created.stderr.trim() || 'docker create failed');
    }
    const cid = created.stdout.trim();
    try {
      await step(`Writing it to ${dir}`, () => unpack({ cid, out: temp, name }));
    } finally {
      await run(['docker', 'rm', '-f', cid]);
    }
    // Another process may have made the same build meanwhile; either will do.
    await rename(temp, dir).catch(async (error) => {
      if (!(await hasImageFiles(image))) {
        throw error;
      }
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
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

// Deletes the builds that are not `keep`, the current one, and that neither
// the snapshot nor any VM runs on, and what builds that stopped halfway left
// behind. `vmDirs` are more dirs of one VM each, such as a RUN_DIR.
const pruneImages = async ({ dataDir, keep, vmDirs = [] }) => {
  const { images, snapshot, machines, run: runDir } = vmLayout(dataDir);
  const used = new Set(keep ? [path.dirname(path.resolve(keep))] : []);
  const note = (machine) => machine?.image && used.add(path.dirname(path.resolve(machine.image)));
  for (const dir of [snapshot, runDir, ...vmDirs]) {
    note(await readMachine(dir));
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

export { buildImage, checkImage, fileStamp, imageSourceHash, imageStatus, latestImage, pruneImages };
