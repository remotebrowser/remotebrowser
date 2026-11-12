import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { describe } = test;
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const runVmConfig = (env) =>
  spawnSync(process.execPath, ['-e', "require('./config')"], {
    cwd: __dirname,
    env: { ...process.env, ...env }
  });

describe('QEMU VMs', () => {
  const readVm = (env) => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const c = require('./config').vmConfig; process.stdout.write(JSON.stringify([c.vmDataDir, c.vmMemory, c.vmCpus, c.vmStartConcurrency]))"
      ],
      { cwd: __dirname, env: { ...process.env, ...env } }
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout.toString());
  };

  test('defaults to a data dir at .data/vm, 4G of memory, 2 CPUs, and 4 starts at once', () => {
    const [dataDir, memory, cpus, startConcurrency] = readVm({
      VM_DATA_DIR: '',
      VM_MEMORY: '',
      VM_CPUS: '',
      VM_START_CONCURRENCY: ''
    });
    assert.match(dataDir, /[/\\]\.data[/\\]vm$/);
    assert.equal(memory, '4G');
    assert.equal(cpus, 2);
    assert.equal(startConcurrency, 4);
  });

  test('honors VM_DATA_DIR, VM_MEMORY, VM_CPUS, and VM_START_CONCURRENCY when set', () => {
    assert.deepEqual(readVm({ VM_DATA_DIR: '/srv/vm', VM_MEMORY: '4096M', VM_CPUS: '4', VM_START_CONCURRENCY: '8' }), [
      '/srv/vm',
      '4096M',
      4,
      8
    ]);
  });

  test('refuses a VM_DATA_DIR too long for the VM sockets', () => {
    const result = runVmConfig({ VM_DATA_DIR: `/srv/${'x'.repeat(80)}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /VM_DATA_DIR is too long for the VM's sockets/);
  });

  test('refuses a malformed VM_MEMORY, VM_CPUS, or VM_START_CONCURRENCY', () => {
    assert.match(runVmConfig({ VM_MEMORY: '2 GB' }).stderr.toString(), /VM_MEMORY must be a size/);
    assert.match(runVmConfig({ VM_CPUS: '0' }).stderr.toString(), /VM_CPUS must be a positive integer/);
    assert.match(
      runVmConfig({ VM_START_CONCURRENCY: '0' }).stderr.toString(),
      /VM_START_CONCURRENCY must be a positive integer/
    );
  });
});

describe('production', () => {
  // vm/scripts/build.js runs in the production image without the app's secrets.
  test('loads without the app settings', () => {
    const result = runVmConfig({ NODE_ENV: 'production', SESSION_SECRET: '', RESOURCE_HMAC_SECRET: '' });
    assert.equal(result.status, 0, result.stderr.toString());
  });
});
