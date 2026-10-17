import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const { consola } = await import('consola/basic');
const { bootstrapVm } = await import('./bootstrap.js');

// Captures what the bootstrap logs, instead of printing it.
const captureLogs = () => {
  const lines = [];
  const saved = { info: consola.info, error: consola.error };
  consola.info = (message, attributes) => lines.push({ level: 'info', message, attributes });
  consola.error = (message, attributes) => lines.push({ level: 'error', message, attributes });
  return { lines, restore: () => Object.assign(consola, saved) };
};

test('the VM bootstrap logs the build before and after, with its duration', async () => {
  const logs = captureLogs();
  try {
    assert.equal(await bootstrapVm({ build: async () => {} }), true);
  } finally {
    logs.restore();
  }
  assert.equal(logs.lines[0].message, 'QEMU preparing the browser VM image and snapshot...');
  assert.match(logs.lines[1].message, /^QEMU preparing the browser VM image and snapshot: done in \d+\.\ds$/);
  assert.equal(typeof logs.lines[1].attributes['rb.duration_ms'], 'number');
});

test('a failed build is logged, and does not reject', async () => {
  const logs = captureLogs();
  try {
    assert.equal(await bootstrapVm({ build: async () => Promise.reject(new Error('no Docker')) }), false);
  } finally {
    logs.restore();
  }
  assert.match(logs.lines[1].message, /failed after \d+\.\ds$/);
  assert.equal(logs.lines.at(-1).message, 'QEMU unable to prepare the browser VM image and snapshot');
  assert.equal(logs.lines.at(-1).attributes['error.type'], 'no Docker');
});
