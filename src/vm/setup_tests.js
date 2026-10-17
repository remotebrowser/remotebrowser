import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PGLITE_DATA_DIR = 'memory://';

const { consola } = await import('consola/basic');
const { setupQemu } = await import('./setup.js');

const OK = { code: 0, stdout: '', stderr: '' };
const runStub = (byBinary) => async (argv) => byBinary[argv[0]] ?? { code: 127, stdout: '', stderr: '' };
const tempDataDir = () => path.join(mkdtempSync(path.join(tmpdir(), 'setup-')), 'vm');

const captureLogs = () => {
  const lines = [];
  const saved = { info: consola.info, error: consola.error };
  consola.info = (message) => lines.push({ level: 'info', message });
  consola.error = (message) => lines.push({ level: 'error', message });
  return { lines, restore: () => Object.assign(consola, saved) };
};

test('setupQemu needs QEMU and qemu-img, and creates the data dir', async () => {
  const dataDir = tempDataDir();
  const logs = captureLogs();
  try {
    await setupQemu({ arch: 'x86_64', dataDir, run: runStub({ 'qemu-system-x86_64': OK, 'qemu-img': OK }) });
  } finally {
    logs.restore();
  }
  assert.ok(statSync(dataDir).isDirectory());
  assert.equal(logs.lines[0].message, 'QEMU setting up...');
});

test('setupQemu fails, and logs an error, without QEMU', async () => {
  const logs = captureLogs();
  try {
    await assert.rejects(
      setupQemu({
        arch: 'x86_64',
        dataDir: tempDataDir(),
        run: runStub({ 'qemu-img': OK })
      }),
      /qemu-system-x86_64 is not available/
    );
  } finally {
    logs.restore();
  }
  assert.equal(logs.lines.at(-1).level, 'error');
});
