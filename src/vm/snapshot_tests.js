import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { MACHINE_VERSION } = await import('./qemu.js');
const { fileStamp, snapshotStatus } = await import('./snapshot.js');

// An image build and a snapshot saved from it, as takeSnapshot leaves them.
const savedSnapshot = async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rb-snapshot-tests-'));
  const build = path.join(dir, 'images', 'debian-13', 'x86_64-aaaa');
  mkdirSync(build, { recursive: true });
  for (const ext of ['qcow2', 'kernel', 'initrd']) {
    writeFileSync(path.join(build, `chromium.${ext}`), ext);
  }
  const image = path.join(build, 'chromium.qcow2');
  const snapshotDir = path.join(dir, 'snapshots', 'debian-13');
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(path.join(snapshotDir, 'vm.state'), 'state');
  const machine = {
    os: 'debian-13',
    arch: 'x86_64',
    accel: 'kvm',
    image,
    memory: '2G',
    imageStamp: await fileStamp(image),
    cpus: 2,
    version: MACHINE_VERSION
  };
  writeFileSync(path.join(snapshotDir, 'machine.json'), JSON.stringify(machine));
  return { image, snapshotDir, wanted: { snapshotDir, image, arch: 'x86_64', memory: '2G', cpus: 2 } };
};

test('a snapshot of this image, with this machine, is current', async () => {
  const { wanted } = await savedSnapshot();
  assert.deepEqual(await snapshotStatus(wanted), { current: true });
});

test('a missing snapshot, or one without its state, is not current', async () => {
  const { wanted, snapshotDir } = await savedSnapshot();
  const missing = await snapshotStatus({ ...wanted, snapshotDir: `${snapshotDir}-missing` });
  assert.equal(missing.current, false);
  assert.match(missing.reason, /No snapshot/);

  writeFileSync(path.join(snapshotDir, 'machine.json'), 'not json');
  assert.equal((await snapshotStatus(wanted)).current, false);
});

test('a snapshot of another build of the image is not current, but still usable', async () => {
  const { wanted } = await savedSnapshot();
  const status = await snapshotStatus({ ...wanted, image: '/other/chromium.qcow2' });
  assert.equal(status.current, false);
  assert.match(status.reason, /older build of the image, not \/other\/chromium\.qcow2/);
  assert.deepEqual(await snapshotStatus({ ...wanted, image: undefined }), { current: true });
});

test('a snapshot whose image build is gone or changed is not usable', async () => {
  const { wanted, image } = await savedSnapshot();
  writeFileSync(image, 'a changed build');
  utimesSync(image, new Date(), new Date(Date.now() + 10000));
  assert.match((await snapshotStatus(wanted)).reason, /unusable: its image .* has changed/);
  rmSync(path.dirname(image), { recursive: true });
  assert.match((await snapshotStatus(wanted)).reason, /unusable: its image file .* is gone/);
});

test('a snapshot of another machine size is not current', async () => {
  const { wanted } = await savedSnapshot();
  const status = await snapshotStatus({ ...wanted, memory: '4G' });
  assert.equal(status.current, false);
  assert.equal(status.reason, 'The snapshot has debian-13 x86_64 2G 2; asked for debian-13 x86_64 4G 2');
});

test('a snapshot of an older QEMU machine is not current', async () => {
  const { wanted, snapshotDir } = await savedSnapshot();
  const saved = JSON.parse(readFileSync(path.join(snapshotDir, 'machine.json'), 'utf8'));
  writeFileSync(path.join(snapshotDir, 'machine.json'), JSON.stringify({ ...saved, version: MACHINE_VERSION - 1 }));
  assert.match((await snapshotStatus(wanted)).reason, /older QEMU machine/);
});

test('a snapshot of another OS is not current', async () => {
  const { wanted } = await savedSnapshot();
  assert.equal(
    (await snapshotStatus({ ...wanted, os: 'other-os' })).reason,
    'The snapshot has debian-13 x86_64 2G 2; asked for other-os x86_64 2G 2'
  );
});
