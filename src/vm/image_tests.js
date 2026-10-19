import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { checkImage, fileStamp, imageSourceHash, imageStatus, latestImage, pruneImages } = await import('./image.js');
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

test('the image of vm/ as it is now is in a build dir named after its sources', async () => {
  const imagesDir = path.join(tempDir(), 'images');
  const source = (await imageSourceHash()).slice(0, 16);
  const missing = await imageStatus({ imagesDir, arch: 'x86_64' });
  assert.equal(missing.current, false);
  assert.equal(missing.image, path.join(imagesDir, `x86_64-${source}`, 'chromium.qcow2'));
  assert.match(missing.reason, /No VM image built from vm\/Dockerfile and vm\/files as they are now/);

  build(imagesDir, `x86_64-${source}`);
  assert.deepEqual(await imageStatus({ imagesDir, arch: 'x86_64' }), { image: missing.image, current: true });
});

test('a build that misses its disk, kernel, or initrd does not count', async () => {
  const imagesDir = path.join(tempDir(), 'images');
  const source = (await imageSourceHash()).slice(0, 16);
  const image = build(imagesDir, `x86_64-${source}`);
  rmSync(image.replace(/qcow2$/, 'kernel'));
  assert.equal((await imageStatus({ imagesDir, arch: 'x86_64' })).current, false);
});

test('latestImage picks the newest complete build of the arch', async () => {
  const imagesDir = path.join(tempDir(), 'images');
  assert.equal(await latestImage(imagesDir, 'x86_64'), null);
  const older = build(imagesDir, 'x86_64-aaaa');
  const newer = build(imagesDir, 'x86_64-bbbb');
  build(imagesDir, 'aarch64-cccc');
  utimesSync(older, new Date(), new Date(Date.now() - 10000));
  assert.equal(await latestImage(imagesDir, 'x86_64'), newer);
  assert.match(await latestImage(imagesDir, 'aarch64'), /aarch64-cccc/);
});

test('the source hash is stable', async () => {
  assert.match(await imageSourceHash(), /^[0-9a-f]{64}$/);
  assert.equal(await imageSourceHash(), await imageSourceHash());
});

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
  const imagesDir = path.join(dataDir, 'images');
  const builds = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => build(imagesDir, `x86_64-${name}`));
  const runsOn = (dir, image) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ image }));
  };
  runsOn(path.join(dataDir, 'snapshot'), builds[0]);
  runsOn(path.join(dataDir, 'machines', 'Qabc12345'), builds[1]);
  runsOn(path.join(dataDir, 'run'), builds[2]);
  const otherRun = path.join(tempDir(), 'run');
  runsOn(otherRun, builds[3]);
  // What a build that stopped halfway leaves behind; no process has this pid.
  mkdirSync(path.join(imagesDir, '.tmp-999999999'));

  const removed = await pruneImages({ dataDir, keep: builds[4], vmDirs: [otherRun] });

  assert.deepEqual(removed.sort(), [path.join(imagesDir, '.tmp-999999999'), path.dirname(builds[5])].sort());
  assert.deepEqual(
    builds.map((image) => existsSync(image)),
    [true, true, true, true, true, false]
  );
});

test('pruneImages leaves alone the build that is being made', async () => {
  const dataDir = tempDir();
  const temp = path.join(dataDir, 'images', `.tmp-${process.pid}`);
  mkdirSync(temp, { recursive: true });
  assert.deepEqual(await pruneImages({ dataDir }), []);
  assert.equal(existsSync(temp), true);
});
