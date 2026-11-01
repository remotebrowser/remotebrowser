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

test('the VM bootstrap builds each OS it can, and logs each build before and after, with its duration', async () => {
  const logs = captureLogs();
  const built = [];
  try {
    const build = async ({ os }) => {
      built.push(os);
    };
    assert.equal(await bootstrapVm({ build, oses: async () => ['debian-13'] }), true);
  } finally {
    logs.restore();
  }
  assert.deepEqual(built, ['debian-13']);
  const messages = logs.lines.map((line) => line.message);
  assert.ok(messages.includes('QEMU preparing the Debian 13 image and snapshot...'));
  const done = logs.lines.find((line) =>
    /^QEMU preparing the Debian 13 image and snapshot: done in \d+\.\ds$/.test(line.message)
  );
  assert.equal(typeof done.attributes['rb.duration_ms'], 'number');
});

test('the VM bootstrap skips an OS that cannot be built here', async () => {
  const logs = captureLogs();
  const built = [];
  try {
    const build = async ({ os }) => {
      built.push(os);
    };
    assert.equal(await bootstrapVm({ build, oses: async () => [] }), true);
  } finally {
    logs.restore();
  }
  assert.deepEqual(built, []);
  assert.equal(logs.lines[0].message, 'QEMU skipping Debian 13, which cannot be built here');
});

test('a failed build is logged, and does not reject', async () => {
  const logs = captureLogs();
  try {
    const build = async () => {
      throw new Error('no docker');
    };
    assert.equal(await bootstrapVm({ build, oses: async () => ['debian-13'] }), false);
  } finally {
    logs.restore();
  }
  const failed = logs.lines.find((line) => line.level === 'error' && line.attributes?.['rb.vm_os']);
  assert.equal(failed.message, 'QEMU unable to prepare the Debian 13 image and snapshot');
  assert.equal(failed.attributes['error.type'], 'no docker');
});
