import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './host.js';
import { hasImageFiles } from './image.js';
import { OSES } from './os.js';
import { step } from './step.js';

// The Linux image: vm/debian-13/Dockerfile, built with Docker, and turned
// into a disk with a kernel and initrd for direct boot. Its services are in
// vm/linux/files.

// The Docker build context, so each Dockerfile can copy vm/linux/files.
const VM_DIR = fileURLToPath(new URL('../../vm', import.meta.url));

// The files of `dir` in vm/, if there is one.
const filesIn = async (dir) => {
  const files = [];
  for (const entry of await readdir(path.join(VM_DIR, dir), { recursive: true }).catch(() => [])) {
    const relative = path.join(dir, entry);
    if ((await stat(path.join(VM_DIR, relative))).isFile()) {
      files.push(relative);
    }
  }
  return files;
};

// What the image of `os` is built from. A change to any of these files means
// the image must be built again.
const sourceFiles = async (os) =>
  [path.join(os, 'Dockerfile'), ...(await filesIn('linux/files')), ...(await filesIn(path.join(os, 'files')))].sort();

// A hash of the names, contents, and exec bits of the image's source files.
const imageSourceHash = async (os) => {
  const hash = createHash('sha256');
  for (const file of await sourceFiles(os)) {
    const full = path.join(VM_DIR, file);
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

// Builds the image of `os` into the build dir of `image`, as imageStatus
// names it. Docker is needed only here, not to run the VMs. The image is for
// the host's architecture, since only that one runs with KVM or HVF. It is
// written to a temporary dir and renamed, so a build that stops halfway
// leaves no build dir behind.
const buildImage = async ({ os, image, arch }) => {
  const info = await run(['docker', 'info']);
  if (info.code !== 0) {
    throw new Error("Docker does not work here, so the VM image cannot be built; 'docker info' shows why");
  }
  const dir = path.dirname(path.resolve(image));
  const temp = path.join(path.dirname(dir), `.tmp-${process.pid}`);
  const name = path.basename(image, '.qcow2');
  const tag = `remotebrowser-vm:${os}-${arch}`;
  const dockerfile = path.join(VM_DIR, os, 'Dockerfile');
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });

  try {
    await step(
      `Building the Docker image ${tag} from vm/${os}/Dockerfile`,
      () => runVisible(['docker', 'build', '-t', tag, '-f', dockerfile, VM_DIR]).done
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

// The builder of the image of `os`, for build.js.
const linuxImage = (os) => ({
  missingSource: async () => null,
  prepareSource: async () => {},
  imageStatus: async ({ imagesDir, arch }) => {
    const image = imageIn(buildDir(imagesDir, arch, await imageSourceHash(os)));
    if (await hasImageFiles(image)) {
      return { image, current: true };
    }
    return { image, current: false, reason: `No ${OSES[os].label} image built from vm/${os} as it is now` };
  },
  buildImage: ({ image, arch }) => buildImage({ os, image, arch })
});

export { imageSourceHash, linuxImage };
