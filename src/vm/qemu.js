import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { run } from './host.js';
import { DEFAULT_OS, guestOf } from './os.js';

const CDP_PORT = 9222;
// QEMU's VNC display 0 is on this port, so display N is on 5900 + N.
const VNC_PORT = 5900;

// A saved state loads only into the same devices. Bump this whenever
// buildQemuArgs changes them, or snapshots change how they are kept, so older
// snapshots are saved again. Version 5 adds a virtual GPU, which QEMU's VNC
// server shows, in place of Xvnc.
const MACHINE_VERSION = 5;

// Every VM started from a snapshot has the same memory, random number state
// included. vmgenid tells the guest kernel that it is a new copy, so it
// reseeds. It needs ACPI, which the aarch64 machine does not have here.
const ARCHES = {
  // Without the HPET, the RTC ticks, which hwclock in the guest needs to set
  // the clock after a resume.
  // Linux guests take input only from the virtio keyboard and tablet: QEMU
  // would send a VNC viewer's pointer to the PS/2 or VMware mouse instead.
  // Windows has no virtio keyboard driver, so it keeps the PS/2 one.
  x86_64: {
    binary: 'qemu-system-x86_64',
    machine: 'q35,hpet=off',
    linuxMachine: 'q35,hpet=off,vmport=off,i8042=off',
    console: 'ttyS0',
    vmgenid: true
  },
  // The best GIC the host offers, so the same args work under KVM, HVF, and TCG.
  aarch64: {
    binary: 'qemu-system-aarch64',
    machine: 'virt,gic-version=max',
    linuxMachine: 'virt,gic-version=max',
    console: 'ttyAMA0',
    vmgenid: false
  }
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

// The kernel and initrd sit next to the root disk image, as linux-image.js
// writes them. Windows boots from its disk, through the BIOS.
const imageFiles = (image, guest = 'linux') => {
  if (guest === 'windows') {
    return { disk: image };
  }
  const base = image.replace(/\.qcow2$/, '');
  return { disk: image, kernel: `${base}.kernel`, initrd: `${base}.initrd` };
};

// QEMU itself serves the screen over VNC, on host loopback, so no guest needs
// a VNC server.
const vncDisplay = (vncHostPort) => {
  if (vncHostPort < VNC_PORT) {
    throw new Error(`QEMU serves VNC only on port ${VNC_PORT} or above, not ${vncHostPort}`);
  }
  return ['-vnc', `127.0.0.1:${vncHostPort - VNC_PORT}`];
};

// Hyper-V enlightenments make Windows much faster under KVM. Only those that
// still let QEMU save the VM: not hv_passthrough, which pins the host's.
const WINDOWS_KVM_CPU = 'host,hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_vpindex,hv_runtime,hv_synic,hv_stimer,hv_time';

// Windows has no virtio drivers until the install adds them, so its disk and
// CD drives sit on the AHCI controller of q35, one per port (ide.0 to ide.5),
// and its NIC is an e1000e. The first CD boots first; Windows Setup boots
// from the disk on its own once it has written it.
const windowsDevices = ({ overlay, cdroms, cdpHostPort, vncHostPort }) => [
  '-drive',
  `file=${overlay},format=qcow2,if=none,id=root,discard=unmap`,
  '-device',
  'ide-hd,drive=root,bus=ide.0,bootindex=1',
  ...cdroms.flatMap((file, i) => [
    '-drive',
    `file=${file},format=raw,if=none,id=cd${i},media=cdrom,readonly=on`,
    '-device',
    `ide-cd,drive=cd${i},bus=ide.${i + 1}${i === 0 ? ',bootindex=0' : ''}`
  ]),
  '-netdev',
  `user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:${cdpHostPort}-:${CDP_PORT}`,
  '-device',
  'e1000e,netdev=net0,romfile=',
  // virtio-gpu takes any screen size, with the viogpudo driver that the
  // setup installs; until then, Windows drives it as a plain VGA.
  '-device',
  'virtio-vga',
  // An absolute pointer, so the VNC cursor and the guest's stay together.
  '-device',
  'qemu-xhci',
  '-device',
  'usb-tablet',
  ...vncDisplay(vncHostPort)
];

const linuxDevices = ({ arch, image, overlay, cdpHostPort, vncHostPort }) => {
  const { kernel, initrd } = imageFiles(image);
  return [
    '-kernel',
    kernel,
    '-initrd',
    initrd,
    '-append',
    `root=/dev/vda rw console=${ARCHES[arch].console} net.ifnames=0 noresume panic=-1`,
    '-drive',
    `file=${overlay},format=qcow2,if=none,id=root,discard=unmap`,
    '-device',
    'virtio-blk-pci,drive=root',
    // Without restrict=on, so Chromium can browse. hostfwd binds only to
    // loopback. No IPv6: its fec0::2 also leads to the host's loopback, and
    // the guest firewall covers IPv4 only.
    '-netdev',
    `user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:${cdpHostPort}-:${CDP_PORT}`,
    '-device',
    'virtio-net-pci,netdev=net0,romfile=',
    // labwc draws on this GPU, which takes any screen size, and starts at the
    // default. Unlike virtio-vga, it is on aarch64 too. The keyboard and
    // tablet take a VNC viewer's input.
    '-device',
    'virtio-gpu-pci,xres=1920,yres=1080',
    '-device',
    'virtio-keyboard-pci',
    '-device',
    'virtio-tablet-pci',
    ...vncDisplay(vncHostPort)
  ];
};

// Unix socket paths have a hard length limit: 108 bytes on Linux, and 104 on
// macOS, both with the closing NUL.
const MAX_SOCKET_PATH = process.platform === 'darwin' ? 103 : 107;

const buildQemuArgs = ({
  os = DEFAULT_OS,
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
  // Only for the Windows install, which boots from these.
  cdroms = [],
  // Windows Setup reboots several times.
  reboot = false,
  // QEMU has seccomp only on Linux.
  seccomp = process.platform === 'linux'
}) => {
  const windows = guestOf(os) === 'windows';
  const { vmgenid } = ARCHES[arch];
  const machine = windows ? ARCHES[arch].machine : ARCHES[arch].linuxMachine;
  const devices = { arch, image, overlay, cdroms, cdpHostPort, vncHostPort };
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
    accel === 'tcg' ? 'max' : windows && accel === 'kvm' ? WINDOWS_KVM_CPU : 'host',
    '-m',
    memory,
    '-smp',
    String(cpus),
    ...(windows ? windowsDevices(devices) : linuxDevices(devices)),
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
    ...(reboot ? [] : ['-no-reboot']),
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
