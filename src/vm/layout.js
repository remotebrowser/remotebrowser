import path from 'node:path';
import { OSES } from './os.js';
import { MAX_SOCKET_PATH } from './qemu.js';

// Everything for the VMs lives in one dir, VM_DATA_DIR. One dir means one
// filesystem, so files move there with a rename, never a copy:
//
//   images/<os>/<arch>-<source>/  one build of the image (os.js),
//                                 never changed once written (image.js)
//   snapshots/<os>/               the VM that new VMs start from
//                                 (snapshot.js)
//   machines/<browser-id>/        one VM per browser (client.js)
//   run/                          the VM that vm/scripts/run.js starts
//                                 (local.js)
const vmLayout = (dataDir) => {
  const root = path.resolve(dataDir);
  return {
    images: path.join(root, 'images'),
    snapshots: path.join(root, 'snapshots'),
    machines: path.join(root, 'machines'),
    run: path.join(root, 'run')
  };
};

const osLayout = (dataDir, os) => {
  const { images, snapshots } = vmLayout(dataDir);
  return { images: path.join(images, os), snapshot: path.join(snapshots, os) };
};

// The longest dir that holds QEMU sockets: a new snapshot, named after the
// pid of the process that saves it (up to 7 digits), or a VM of the longest
// browser id that the app makes (generateShortId('Q', 8)).
const longestSocketPath = (dataDir) => {
  const { machines } = vmLayout(dataDir);
  const snapshots = Object.keys(OSES).map((os) => `${osLayout(dataDir, os).snapshot}.new.4194304`);
  const dirs = [...snapshots, path.join(machines, 'Q12345678')];
  return dirs.map((dir) => path.join(dir, 'qmp.sock')).reduce((a, b) => (b.length > a.length ? b : a));
};

const socketPathsFit = (dataDir) => longestSocketPath(dataDir).length <= MAX_SOCKET_PATH;

export { osLayout, socketPathsFit, vmLayout };
