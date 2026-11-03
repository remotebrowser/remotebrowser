import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { consola } from 'consola/basic';
import * as host from './host.js';
import { fileStamp } from './image.js';
import { ARCHES, buildQemuArgs, detectAccel } from './qemu.js';
import { LOG_ATTRIBUTES, step } from './step.js';

// The Windows 11 image is not built with Docker, as the Linux ones are, but
// installed: QEMU boots the sysadmin's Windows ISO, and Windows Setup follows
// vm/windows-11/autounattend.xml. At the end of Setup, remotebrowser-setup.ps1
// installs the guest agent from the virtio-win ISO and shuts Windows down.
// The disk is then the image, and snapshot.js boots it like a Linux one.

const WINDOWS_SOURCE_DIR = fileURLToPath(new URL('../../vm/windows-11', import.meta.url));

// Windows is not free to redistribute, so the sysadmin puts the install ISO
// in the iso dir (layout.js). The virtio-win ISO, with the guest agent and
// the drivers, and the 3proxy zip are downloaded there.
const WINDOWS_ISO = 'windows-11.iso';
const VIRTIO_ISO = 'virtio-win.iso';
const VIRTIO_ISO_URL = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso';

// 3proxy, the local proxy in the guest that forwards the browser's traffic to
// the upstream proxy, as tinyproxy does in the Linux guest. The x64 zip holds
// a single static 3proxy.exe, which the guest expands and installs as a
// service (vm/windows-11/remotebrowser-setup.ps1). The build is for Windows
// Vista and later.
const THREEPROXY_VERSION = '1.0.2';
const THREEPROXY_ZIP = `3proxy-${THREEPROXY_VERSION}-x64.zip`;
const THREEPROXY_URL = `https://github.com/3proxy/3proxy/releases/download/${THREEPROXY_VERSION}/${THREEPROXY_ZIP}`;
// The name the zip takes on the unattend CD, where the guest reads it.
const THREEPROXY_ISO_NAME = '3proxy.zip';

// The generic Pro key: it picks the edition, but does not activate it.
const PRODUCT_KEY = 'W269N-WFGWX-YVC9B-4J6C9-T83GX';

// The qcow2 only grows as Windows writes, so this is a cap, not a cost.
const DISK_SIZE = '64G';

// Lines that remotebrowser-setup.ps1 writes to COM1.
const SETUP_DONE = 'remotebrowser: windows setup done';
const SETUP_FAILED = 'remotebrowser: windows setup failed';

// A Windows install takes 10 to 30 minutes under KVM, far more under TCG.
const INSTALL_TIMEOUT_MS = 3 * 60 * 60 * 1000;

const ISO_TOOLS = [['xorriso', '-as', 'mkisofs'], ['genisoimage'], ['mkisofs']];

const isosIn = (isoDir) => ({
  windowsIso: path.join(isoDir, WINDOWS_ISO),
  virtioIso: path.join(isoDir, VIRTIO_ISO),
  threeproxyZip: path.join(isoDir, THREEPROXY_ZIP)
});

// What the image is installed from: the files in vm/windows-11, the ISOs,
// and the product key. An ISO is too big to hash, so its size and mtime
// stand in.
const windowsSourceHash = async ({ windowsIso, virtioIso, threeproxyZip, productKey }) => {
  const hash = createHash('sha256');
  for (const file of (await readdir(WINDOWS_SOURCE_DIR)).sort()) {
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(WINDOWS_SOURCE_DIR, file)));
    hash.update('\0');
  }
  for (const file of [windowsIso, virtioIso, threeproxyZip]) {
    hash.update(`${file}\0${await fileStamp(file)}\0`);
  }
  hash.update(productKey);
  return hash.digest('hex');
};

const checkIsos = async ({ windowsIso, virtioIso, threeproxyZip }) => {
  for (const file of [windowsIso, virtioIso, threeproxyZip]) {
    await access(file, fsConstants.R_OK).catch(() => {
      throw new Error(`${file} is not there, or the app cannot read it`);
    });
  }
};

// Why the image cannot be installed here, or null.
const missingSource = async ({ isoDir, arch }) => {
  if (arch !== 'x86_64') {
    return `Windows 11 needs an x86_64 host, not ${arch}`;
  }
  const { windowsIso } = isosIn(isoDir);
  return access(windowsIso, fsConstants.R_OK).then(
    () => null,
    () => `No Windows 11 install ISO at ${windowsIso}`
  );
};

// Downloads `url` to `dest`, unless it is there already. A download cut short
// must not look like the file.
const download = async ({ url, dest, fetchImpl }) => {
  if (
    await access(dest).then(
      () => true,
      () => false
    )
  ) {
    return;
  }
  await step(`Downloading ${url}`, async () => {
    const response = await fetchImpl(url);
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
    }
    await mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      await rename(part, dest);
    } finally {
      await rm(part, { force: true });
    }
  });
};

// Downloads the virtio-win ISO, with the drivers and the guest agent, and the
// 3proxy zip, unless they are there already.
const prepareSource = async ({ isoDir, fetchImpl = globalThis.fetch }) => {
  const { virtioIso, threeproxyZip } = isosIn(isoDir);
  await download({ url: VIRTIO_ISO_URL, dest: virtioIso, fetchImpl });
  await download({ url: THREEPROXY_URL, dest: threeproxyZip, fetchImpl });
};

// The install that fits the ISOs and vm/windows-11 as they are now, and
// whether it is there yet. Its dir is named like a Linux build's, so
// pruneImages in image.js removes it once no VM runs on it.
const imageStatus = async ({ imagesDir, arch, isoDir, productKey = PRODUCT_KEY }) => {
  const { windowsIso, virtioIso, threeproxyZip } = isosIn(isoDir);
  await checkIsos({ windowsIso, virtioIso, threeproxyZip });
  const source = await windowsSourceHash({ windowsIso, virtioIso, threeproxyZip, productKey });
  const image = path.join(imagesDir, `${arch}-${source.slice(0, 16)}`, 'windows.qcow2');
  const there = await access(image).then(
    () => true,
    () => false
  );
  if (there) {
    return { image, current: true };
  }
  return { image, current: false, reason: 'No Windows 11 image installed from these ISOs and vm/windows-11' };
};

const findIsoTool = async (run) => {
  for (const tool of ISO_TOOLS) {
    if ((await run([tool[0], '-version'])).code === 0) {
      return tool;
    }
  }
  throw new Error('Making the unattend ISO needs xorriso, genisoimage, or mkisofs');
};

// The unattend CD: autounattend.xml, which Windows Setup looks for on every
// CD, and the scripts that run at the end of Setup, with the 3proxy zip.
const makeUnattendIso = async ({ dir, productKey, threeproxyZip, run = host.run }) => {
  const tool = await findIsoTool(run);
  // Only Windows itself needs the password, for autologon.
  const password = randomBytes(18).toString('base64url');
  const files = path.join(dir, 'unattend');
  await mkdir(files, { recursive: true });
  for (const file of await readdir(WINDOWS_SOURCE_DIR)) {
    const text = await readFile(path.join(WINDOWS_SOURCE_DIR, file), 'utf8');
    await writeFile(
      path.join(files, file),
      text.replaceAll('{{PRODUCT_KEY}}', productKey).replaceAll('{{PASSWORD}}', password),
      { mode: 0o600 }
    );
  }
  // The zip is a binary, so it goes in as it is, for the guest to expand.
  if (threeproxyZip) {
    await copyFile(threeproxyZip, path.join(files, THREEPROXY_ISO_NAME));
  }
  const iso = path.join(dir, 'unattend.iso');
  const made = await run([...tool, '-quiet', '-J', '-r', '-V', 'UNATTEND', '-o', iso, files]);
  if (made.code !== 0) {
    throw new Error(made.stderr.trim() || `${tool[0]} exited with code ${made.code}`);
  }
  await rm(files, { recursive: true, force: true });
  return iso;
};

// Installs Windows into the build dir of `image`, as imageStatus names it.
// It is written to a temporary dir and renamed, so an install that stops
// halfway leaves no build dir behind.
const buildImage = async ({
  image,
  arch,
  memory,
  cpus,
  isoDir,
  productKey = PRODUCT_KEY,
  installTimeoutMs = INSTALL_TIMEOUT_MS
}) => {
  if (arch !== 'x86_64') {
    throw new Error(`Windows 11 needs an x86_64 host, not ${arch}`);
  }
  const { windowsIso, virtioIso, threeproxyZip } = isosIn(isoDir);
  await checkIsos({ windowsIso, virtioIso, threeproxyZip });
  const dir = path.dirname(path.resolve(image));
  // Named like the temporary dirs of linux-image.js, so pruneImages cleans
  // up after an install that the app's exit cut short.
  const temp = path.join(path.dirname(dir), `.tmp-${process.pid}`);
  const disk = path.join(temp, path.basename(image));
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true, mode: 0o700 });

  /** @type {number | undefined} */
  let pid;
  try {
    const created = await host.run(['qemu-img', 'create', '-q', '-f', 'qcow2', disk, DISK_SIZE]);
    if (created.code !== 0) {
      throw new Error(created.stderr.trim() || `qemu-img exited with code ${created.code}`);
    }
    const unattendIso = await makeUnattendIso({ dir: temp, productKey, threeproxyZip });
    const accel = await detectAccel();
    if (accel === 'tcg') {
      consola.warn('QEMU has no KVM here; Windows installs under slow emulation, which takes hours', LOG_ATTRIBUTES);
    }
    const cdpHostPort = await host.freePort();
    let vncHostPort = await host.freePort();
    while (vncHostPort === cdpHostPort) {
      vncHostPort = await host.freePort();
    }
    const args = buildQemuArgs({
      os: 'windows-11',
      name: 'windows-install',
      arch,
      accel,
      overlay: disk,
      dir: temp,
      memory,
      cpus,
      cdpHostPort,
      vncHostPort,
      cdroms: [windowsIso, virtioIso, unattendIso],
      reboot: true
    });
    const started = await host.start([ARCHES[arch].binary, ...args], path.join(temp, 'qemu.log'));
    pid = started.pid;
    let exited = false;
    void started.exited.then(() => {
      exited = true;
    });
    consola.info(`QEMU a VNC viewer can watch the install at 127.0.0.1:${vncHostPort}`, LOG_ATTRIBUTES);

    const consoleLog = path.join(temp, 'console.log');
    const install = async () => {
      const deadline = Date.now() + installTimeoutMs;
      while (!exited && (await host.isAlive(started.pid, temp))) {
        if (Date.now() > deadline) {
          throw new Error('Windows did not install in time');
        }
        await host.delay(1000);
      }
      const log = await readFile(consoleLog, 'utf8').catch(() => '');
      if (!log.includes(SETUP_DONE)) {
        const failed = log.split('\n').find((line) => line.startsWith(SETUP_FAILED));
        await copyFile(consoleLog, `${dir}.failed.log`).catch(() => {});
        const qemuLog = await host.lastLines(path.join(temp, 'qemu.log'));
        throw new Error(
          `${failed?.trim() || 'QEMU quit before the Windows setup was done'}; the guest console is in ${dir}.failed.log${qemuLog ? `\n${qemuLog}` : ''}`
        );
      }
    };
    await step(`Installing Windows from ${windowsIso}`, install);
    pid = undefined;

    await mkdir(dir, { recursive: true, mode: 0o700 });
    await rename(disk, image);
  } finally {
    // QEMU may already be gone, e.g. after a failed setup.
    if (pid && (await host.isAlive(pid, temp))) {
      host.kill(pid, 'SIGKILL');
    }
    await rm(temp, { recursive: true, force: true });
  }
};

// The builder of the Windows 11 image, for build.js.
const windowsImage = () => ({ missingSource, prepareSource, imageStatus, buildImage });

export { buildImage, imageStatus, makeUnattendIso, missingSource, prepareSource, windowsImage };
