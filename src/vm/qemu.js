import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { run } from './host.js';

const CDP_PORT = 9222;
// The guest's display over RFB, for any VNC viewer on the host.
const VNC_PORT = 5900;

// A saved state loads only into the same devices. Bump this whenever
// buildQemuArgs changes them, or snapshots change how they are kept, so older
// snapshots are saved again. Version 4 runs snapshots on a build in
// VM_DATA_DIR/images (image.js).
const MACHINE_VERSION = 4;

// Every VM started from a snapshot has the same memory, random number state
// included. vmgenid tells the guest kernel that it is a new copy, so it
// reseeds. It needs ACPI, which the aarch64 machine does not have here.
const ARCHES = {
  // Without the HPET, the RTC ticks, which hwclock in the guest needs to set
  // the clock after a resume.
  x86_64: { binary: 'qemu-system-x86_64', machine: 'q35,hpet=off', console: 'ttyS0', vmgenid: true },
  // The best GIC the host offers, so the same args work under KVM, HVF, and TCG.
  aarch64: { binary: 'qemu-system-aarch64', machine: 'virt,gic-version=max', console: 'ttyAMA0', vmgenid: false }
};

const hostArch = (nodeArch = process.arch) => (nodeArch === 'arm64' ? 'aarch64' : 'x86_64');

// KVM on Linux, only when the app may open it. macOS has no KVM, but its
// Hypervisor.framework (HVF) runs the VMs natively too. Otherwise QEMU falls
// back to slow emulation.
const detectAccel = async ({ platform = process.platform, kvmDevice = '/dev/kvm', runImpl = run } = {}) => {
  if (platform === 'darwin') {
    const { code, stdout } = await runImpl(['sysctl', '-n', 'kern.hv_support']);
    return code === 0 && stdout.trim() === '1' ? 'hvf' : 'tcg';
  }
  try {
    await access(kvmDevice, fsConstants.R_OK | fsConstants.W_OK);
    return 'kvm';
  } catch {
    return 'tcg';
  }
};

// The kernel and initrd sit next to the root disk image, as vm/scripts/build.js writes them.
const imageFiles = (image) => {
  const base = image.replace(/\.qcow2$/, '');
  return { disk: image, kernel: `${base}.kernel`, initrd: `${base}.initrd` };
};

// Unix socket paths have a hard length limit: 108 bytes on Linux, and 104 on
// macOS, both with the closing NUL.
const MAX_SOCKET_PATH = process.platform === 'darwin' ? 103 : 107;

const buildQemuArgs = ({
  name,
  arch,
  accel,
  image,
  overlay,
  dir,
  memory,
  cpus,
  cdpHostPort,
  vncHostPort,
  incoming,
  consoleOnStdio = false,
  // QEMU has seccomp only on Linux.
  seccomp = process.platform === 'linux'
}) => {
  const { machine, console: tty, vmgenid } = ARCHES[arch];
  const { kernel, initrd } = imageFiles(image);
  return [
    '-name',
    name,
    // Only the devices listed here exist; no default NIC, VGA, floppy, etc.
    '-nodefaults',
    '-no-user-config',
    '-machine',
    machine,
    '-accel',
    accel,
    '-cpu',
    accel === 'tcg' ? 'max' : 'host',
    '-m',
    memory,
    '-smp',
    String(cpus),
    '-kernel',
    kernel,
    '-initrd',
    initrd,
    '-append',
    `root=/dev/vda rw console=${tty} net.ifnames=0 noresume panic=-1`,
    '-drive',
    `file=${overlay},format=qcow2,if=none,id=root,discard=unmap`,
    '-device',
    'virtio-blk-pci,drive=root',
    // Without restrict=on, so Chromium can browse. hostfwd binds only to
    // loopback. No IPv6: its fec0::2 also leads to the host's loopback, and
    // the guest firewall covers IPv4 only.
    '-netdev',
    `user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:${cdpHostPort}-:${CDP_PORT},hostfwd=tcp:127.0.0.1:${vncHostPort}-:${VNC_PORT}`,
    '-device',
    'virtio-net-pci,netdev=net0,romfile=',
    // Chromium and TLS need entropy early in boot.
    '-device',
    'virtio-rng-pci',
    ...(vmgenid ? ['-device', 'vmgenid'] : []),
    // The guest agent's channel, used to set the guest clock after a resume.
    '-device',
    'virtio-serial-pci',
    '-chardev',
    `socket,id=qga,path=${path.join(dir, 'qga.sock')},server=on,wait=off`,
    '-device',
    'virtserialport,chardev=qga,name=org.qemu.guest_agent.0',
    // QEMU's control socket, used to suspend the VM. The dir is private to
    // the app's user, which keeps everyone else off both sockets.
    '-qmp',
    `unix:${path.join(dir, 'qmp.sock')},server=on,wait=off`,
    '-display',
    'none',
    // The terminal is the console only for a VM started by hand.
    '-serial',
    consoleOnStdio ? 'mon:stdio' : `file:${path.join(dir, 'console.log')}`,
    // A guest that panics or reboots ends the VM, instead of looping.
    '-no-reboot',
    // Seccomp: a compromised QEMU cannot exec, fork, or gain privileges. This
    // also rules out -daemonize, which forks, so the app detaches QEMU instead.
    ...(seccomp ? ['-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny'] : []),
    '-pidfile',
    path.join(dir, 'qemu.pid'),
    // A saved state to start from, instead of booting.
    ...(incoming ? ['-incoming', `file:${incoming}`] : [])
  ];
};

export { ARCHES, MACHINE_VERSION, MAX_SOCKET_PATH, buildQemuArgs, detectAccel, hostArch, imageFiles };
