import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { imageSourceHash, linuxImage } = await import('./linux-image.js');

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'rb-linux-image-tests-'));

// A build as buildImage leaves it, in images/<os>/<name>/.
const build = (imagesDir, name) => {
  const dir = path.join(imagesDir, name);
  mkdirSync(dir, { recursive: true });
  for (const ext of ['qcow2', 'kernel', 'initrd']) {
    writeFileSync(path.join(dir, `chromium.${ext}`), `${name} ${ext}`);
  }
  return path.join(dir, 'chromium.qcow2');
};

test('the image as its sources are now is in a build dir named after them', async () => {
  const imagesDir = path.join(tempDir(), 'images', 'debian-13');
  const source = (await imageSourceHash('debian-13')).slice(0, 16);
  const { imageStatus } = linuxImage('debian-13');
  const missing = await imageStatus({ imagesDir, arch: 'x86_64' });
  assert.equal(missing.current, false);
  assert.equal(missing.image, path.join(imagesDir, `x86_64-${source}`, 'chromium.qcow2'));
  assert.equal(missing.reason, 'No Debian 13 image built from vm/debian-13 as it is now');

  build(imagesDir, `x86_64-${source}`);
  assert.deepEqual(await imageStatus({ imagesDir, arch: 'x86_64' }), { image: missing.image, current: true });
});

test('a build that misses its disk, kernel, or initrd does not count', async () => {
  const imagesDir = path.join(tempDir(), 'images', 'debian-13');
  const source = (await imageSourceHash('debian-13')).slice(0, 16);
  const image = build(imagesDir, `x86_64-${source}`);
  rmSync(image.replace(/qcow2$/, 'kernel'));
  assert.equal((await linuxImage('debian-13').imageStatus({ imagesDir, arch: 'x86_64' })).current, false);
});

test('the source hash of the image is stable', async () => {
  const debian = await imageSourceHash('debian-13');
  assert.match(debian, /^[0-9a-f]{64}$/);
  assert.equal(await imageSourceHash('debian-13'), debian);
});
