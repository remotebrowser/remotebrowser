import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { checkImage, fileStamp, pruneImages } = await import('./image.js');
const { consola } = await import('consola/basic');
consola.level = -999;

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'rb-image-tests-'));

// A build as buildImage leaves it, in images/<name>/.
const build = (imagesDir, name, content = name) => {
  const dir = path.join(imagesDir, name);
  mkdirSync(dir, { recursive: true });
  for (const ext of ['qcow2', 'kernel', 'initrd']) {
    writeFileSync(path.join(dir, `chromium.${ext}`), `${content} ${ext}`);
  }
  return path.join(dir, 'chromium.qcow2');
};

test('checkImage refuses an image file that is gone or changed', async () => {
  const image = build(path.join(tempDir(), 'images'), 'x86_64-aaaa', 'v1');
  const machine = { image, imageStamp: await fileStamp(image) };
  await checkImage(machine);
  writeFileSync(image, 'v1 qcow2, but longer');
  await assert.rejects(checkImage(machine), /has changed since it started/);
  await assert.rejects(checkImage({ image: path.join(path.dirname(image), 'missing.qcow2') }), /is gone/);
});

test('pruneImages keeps the current build, and those that the snapshot or a VM runs on', async () => {
  const dataDir = tempDir();
  const imagesDir = path.join(dataDir, 'images', 'debian-13');
  const builds = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => build(imagesDir, `x86_64-${name}`));
  // A prune never removes the builds in another images/<os> dir.
  const other = build(path.join(dataDir, 'images', 'other-os'), 'x86_64-g');
  const runsOn = (dir, image) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ image }));
  };
  runsOn(path.join(dataDir, 'snapshots', 'debian-13'), builds[0]);
  runsOn(path.join(dataDir, 'machines', 'Qabc12345'), builds[1]);
  runsOn(path.join(dataDir, 'run'), builds[2]);
  const otherRun = path.join(tempDir(), 'run');
  runsOn(otherRun, builds[3]);
  // What a build that stopped halfway leaves behind; no process has this pid.
  mkdirSync(path.join(imagesDir, '.tmp-999999999'));

  const removed = await pruneImages({ dataDir, os: 'debian-13', keep: builds[4], vmDirs: [otherRun] });

  assert.deepEqual(removed.sort(), [path.join(imagesDir, '.tmp-999999999'), path.dirname(builds[5])].sort());
  assert.deepEqual(
    builds.map((image) => existsSync(image)),
    [true, true, true, true, true, false]
  );
  assert.equal(existsSync(other), true);
});

test('pruneImages leaves alone the build that is being made', async () => {
  const dataDir = tempDir();
  const temp = path.join(dataDir, 'images', 'debian-13', `.tmp-${process.pid}`);
  mkdirSync(temp, { recursive: true });
  assert.deepEqual(await pruneImages({ dataDir, os: 'debian-13' }), []);
  assert.equal(existsSync(temp), true);
});
