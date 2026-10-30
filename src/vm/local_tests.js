import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { localState, resumeLocal, startFromSnapshot, suspendLocal } = await import('./local.js');
const { MACHINE_VERSION } = await import('./qemu.js');
const { fileStamp } = await import('./snapshot.js');

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'rb-local-tests-'));

// An image build: its disk, kernel, and initrd.
const buildIn = (dir) => {
  for (const ext of ['qcow2', 'kernel', 'initrd']) {
    writeFileSync(path.join(dir, `chromium.${ext}`), ext);
  }
  return path.join(dir, 'chromium.qcow2');
};

test('localState tells a suspended VM from one that is gone', async () => {
  const runDir = path.join(tempDir(), 'run');
  assert.deepEqual(await localState(runDir), { dir: runDir, pid: null, running: false, suspended: false });
  mkdirSync(runDir);
  writeFileSync(path.join(runDir, 'suspended.state'), 'state');
  assert.equal((await localState(runDir)).suspended, true);
});

test('localState counts a compressed state as suspended', async () => {
  const runDir = path.join(tempDir(), 'run');
  mkdirSync(runDir);
  writeFileSync(path.join(runDir, 'suspended.state.zst'), 'state');
  assert.equal((await localState(runDir)).suspended, true);
});

test('startFromSnapshot needs a snapshot on its image build as it was', async () => {
  const dir = tempDir();
  const runDir = path.join(dir, 'run');
  const snapshotDir = path.join(dir, 'snapshot');
  await assert.rejects(startFromSnapshot({ snapshotDir, runDir }), /No snapshot in .*build-image\.sh/);

  const image = buildIn(dir);
  mkdirSync(snapshotDir);
  writeFileSync(path.join(snapshotDir, 'vm.state'), 'state');
  const machine = {
    arch: 'x86_64',
    accel: 'kvm',
    image,
    memory: '2G',
    cpus: 2,
    imageStamp: `${await fileStamp(image)}0`,
    version: MACHINE_VERSION
  };
  writeFileSync(path.join(snapshotDir, 'machine.json'), JSON.stringify(machine));
  await assert.rejects(startFromSnapshot({ snapshotDir, runDir }), /has changed.*save a new one/);
});

test('startFromSnapshot leaves a suspended VM alone', async () => {
  const dir = tempDir();
  const image = buildIn(dir);
  const snapshotDir = path.join(dir, 'snapshot');
  mkdirSync(snapshotDir);
  writeFileSync(path.join(snapshotDir, 'vm.state'), 'state');
  const machine = {
    arch: 'x86_64',
    accel: 'kvm',
    image,
    memory: '2G',
    cpus: 2,
    imageStamp: await fileStamp(image),
    version: MACHINE_VERSION
  };
  writeFileSync(path.join(snapshotDir, 'machine.json'), JSON.stringify(machine));
  const runDir = path.join(dir, 'run');
  mkdirSync(runDir);
  writeFileSync(path.join(runDir, 'suspended.state'), 'state');
  await assert.rejects(startFromSnapshot({ snapshotDir, runDir }), /is suspended/);
});

test('suspend and resume need a VM in the right state', async () => {
  const runDir = path.join(tempDir(), 'run');
  await assert.rejects(suspendLocal({ runDir }), /No VM is running/);
  await assert.rejects(resumeLocal({ runDir }), /No suspended VM/);
});
