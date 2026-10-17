import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { compressFile, decompressFile } = await import('./compress.js');
const { consola } = await import('consola/basic');
consola.level = -999;

const stateFile = () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'rb-compress-tests-')), 'suspended.state');
  // Repetitive, as saved memory mostly is.
  writeFileSync(file, 'guest memory '.repeat(100000));
  return file;
};

test('compressFile replaces the file with a smaller .zst, and decompressFile brings it back', async () => {
  const file = stateFile();
  const original = readFileSync(file, 'utf8');

  const result = await compressFile(file);

  assert.equal(result.file, `${file}.zst`);
  assert.ok(result.after < result.before / 10);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.zst.part`), false);

  await decompressFile(`${file}.zst`);

  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(`${file}.zst`), false);
});

test('a failed compression keeps the original and leaves no partial file', async () => {
  const file = stateFile();
  await assert.rejects(compressFile(file, { binary: 'false' }), /false exited with code 1/);
  await assert.rejects(compressFile(file, { binary: 'no-such-zstd' }), /no-such-zstd is not installed/);
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(`${file}.zst`), false);
  assert.equal(existsSync(`${file}.zst.part`), false);
});

test('a failed decompression keeps the compressed file', async () => {
  const file = stateFile();
  await compressFile(file);
  await assert.rejects(decompressFile(`${file}.zst`, { binary: 'false' }));
  assert.equal(existsSync(`${file}.zst`), true);
  assert.equal(existsSync(file), false);
});
