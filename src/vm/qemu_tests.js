import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildQemuArgs, detectAccel, hostArch, imageFiles } from './qemu.js';

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('buildQemuArgs boots the image kernel with a disposable overlay and no default devices', () => {
  const args = buildQemuArgs({
    name: 'chromium-Qabc12345',
    arch: 'x86_64',
    accel: 'kvm',
    image: '/images/chromium-x86_64.qcow2',
    overlay: '/state/chromium-Qabc12345/overlay.qcow2',
    dir: '/state/chromium-Qabc12345',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 34567,
    vncHostPort: 34568
  });
  assert.ok(args.includes('-nodefaults'));
  assert.equal(valueAfter(args, '-machine'), 'q35,hpet=off');
  assert.equal(valueAfter(args, '-accel'), 'kvm');
  assert.equal(valueAfter(args, '-cpu'), 'host');
  assert.equal(valueAfter(args, '-m'), '2G');
  assert.equal(valueAfter(args, '-smp'), '2');
  assert.equal(valueAfter(args, '-kernel'), '/images/chromium-x86_64.kernel');
  assert.equal(valueAfter(args, '-initrd'), '/images/chromium-x86_64.initrd');
  assert.match(valueAfter(args, '-append'), /^root=\/dev\/vda rw /);
  assert.match(valueAfter(args, '-drive'), /^file=\/state\/chromium-Qabc12345\/overlay\.qcow2,format=qcow2,/);
  assert.equal(valueAfter(args, '-pidfile'), '/state/chromium-Qabc12345/qemu.pid');
  // -daemonize forks, which the seccomp sandbox forbids.
  assert.ok(!args.includes('-daemonize'));
});

test('buildQemuArgs forwards only CDP and VNC, and only on host loopback', () => {
  const args = buildQemuArgs({
    name: 'chromium-Qabc12345',
    arch: 'x86_64',
    accel: 'kvm',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 34567,
    vncHostPort: 34568
  });
  const netdevs = args.filter((_arg, index) => args[index - 1] === '-netdev');
  assert.deepEqual(netdevs, [
    'user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:34567-:9222,hostfwd=tcp:127.0.0.1:34568-:5900'
  ]);
});

test('buildQemuArgs confines QEMU with seccomp', () => {
  const args = buildQemuArgs({
    name: 'n',
    arch: 'x86_64',
    accel: 'kvm',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 1,
    vncHostPort: 2,
    seccomp: true
  });
  const sandbox = valueAfter(args, '-sandbox');
  for (const option of ['on', 'spawn=deny', 'elevateprivileges=deny', 'obsolete=deny', 'resourcecontrol=deny']) {
    assert.ok(sandbox.split(',').includes(option), `expected ${option} in -sandbox`);
  }
});

// QEMU on macOS refuses -sandbox, since it is built without seccomp.
test('buildQemuArgs runs HVF VMs on the host CPU, without seccomp', () => {
  const args = buildQemuArgs({
    name: 'n',
    arch: 'aarch64',
    accel: 'hvf',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 1,
    vncHostPort: 2,
    seccomp: false
  });
  assert.equal(valueAfter(args, '-accel'), 'hvf');
  assert.equal(valueAfter(args, '-cpu'), 'host');
  assert.ok(!args.includes('-sandbox'));
});

test('buildQemuArgs picks the machine and console per architecture, and a portable CPU under emulation', () => {
  const args = buildQemuArgs({
    name: 'n',
    arch: 'aarch64',
    accel: 'tcg',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 1,
    vncHostPort: 2
  });
  assert.equal(valueAfter(args, '-machine'), 'virt,gic-version=max');
  assert.equal(valueAfter(args, '-cpu'), 'max');
  assert.match(valueAfter(args, '-append'), /console=ttyAMA0/);
});

test('imageFiles finds the kernel and initrd next to the disk image', () => {
  assert.deepEqual(imageFiles('/v/chromium-x86_64.qcow2'), {
    disk: '/v/chromium-x86_64.qcow2',
    kernel: '/v/chromium-x86_64.kernel',
    initrd: '/v/chromium-x86_64.initrd'
  });
});

test('hostArch maps the Node.js arch to the QEMU target', () => {
  assert.equal(hostArch('x64'), 'x86_64');
  assert.equal(hostArch('arm64'), 'aarch64');
});

test('detectAccel uses KVM only when the device can be opened', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rb-qemu-tests-'));
  const device = path.join(dir, 'kvm');
  writeFileSync(device, '');
  assert.equal(await detectAccel({ platform: 'linux', kvmDevice: device }), 'kvm');
  assert.equal(await detectAccel({ platform: 'linux', kvmDevice: path.join(dir, 'missing') }), 'tcg');
});

test('detectAccel uses HVF on macOS when the kernel supports it', async () => {
  const sysctl =
    (stdout, code = 0) =>
    async () => ({ code, stdout, stderr: '' });
  assert.equal(await detectAccel({ platform: 'darwin', runImpl: sysctl('1\n') }), 'hvf');
  assert.equal(await detectAccel({ platform: 'darwin', runImpl: sysctl('0\n') }), 'tcg');
  assert.equal(await detectAccel({ platform: 'darwin', runImpl: sysctl('', 1) }), 'tcg');
});

test('buildQemuArgs gives QEMU a control socket and a guest agent channel in the VM dir', () => {
  const args = buildQemuArgs({
    name: 'n',
    arch: 'x86_64',
    accel: 'kvm',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 1,
    vncHostPort: 2
  });
  assert.equal(valueAfter(args, '-qmp'), 'unix:/s/qmp.sock,server=on,wait=off');
  assert.equal(valueAfter(args, '-chardev'), 'socket,id=qga,path=/s/qga.sock,server=on,wait=off');
  assert.ok(args.includes('virtserialport,chardev=qga,name=org.qemu.guest_agent.0'));
  assert.ok(!args.includes('-incoming'));
});

test('buildQemuArgs loads the saved state when resuming', () => {
  const args = buildQemuArgs({
    name: 'n',
    arch: 'x86_64',
    accel: 'kvm',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 1,
    vncHostPort: 2,
    incoming: '/s/suspended.state'
  });
  assert.equal(valueAfter(args, '-incoming'), 'file:/s/suspended.state');
});

// VMs from one snapshot share its memory; vmgenid makes each guest reseed.
test('buildQemuArgs adds vmgenid where the machine supports it', () => {
  const machine = {
    name: 'n',
    accel: 'kvm',
    image: '/i/c.qcow2',
    overlay: '/s/o.qcow2',
    dir: '/s',
    memory: '2G',
    cpus: 2,
    cdpHostPort: 1,
    vncHostPort: 2
  };
  assert.ok(buildQemuArgs({ ...machine, arch: 'x86_64' }).includes('vmgenid'));
  assert.ok(!buildQemuArgs({ ...machine, arch: 'aarch64' }).includes('vmgenid'));
});
