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
        "const c = require('./config').vmConfig; process.stdout.write(JSON.stringify([c.vmDataDir, c.vmMemory, c.vmCpus]))"
      ],
      { cwd: __dirname, env: { ...process.env, ...env } }
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout.toString());
  };

  test('defaults to a data dir at .data/vm, 2G and 2 CPUs', () => {
    const [dataDir, memory, cpus] = readVm({ VM_DATA_DIR: '', VM_MEMORY: '', VM_CPUS: '' });
    assert.match(dataDir, /[/\\]\.data[/\\]vm$/);
    assert.equal(memory, '2G');
    assert.equal(cpus, 2);
  });

  test('honors VM_DATA_DIR, VM_MEMORY, and VM_CPUS when set', () => {
    assert.deepEqual(readVm({ VM_DATA_DIR: '/srv/vm', VM_MEMORY: '4096M', VM_CPUS: '4' }), ['/srv/vm', '4096M', 4]);
  });

  test('refuses a VM_DATA_DIR too long for the VM sockets', () => {
    const result = runVmConfig({ VM_DATA_DIR: `/srv/${'x'.repeat(80)}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /VM_DATA_DIR is too long for the VM's sockets/);
  });

  test('refuses a malformed VM_MEMORY or VM_CPUS', () => {
    assert.match(runVmConfig({ VM_MEMORY: '2 GB' }).stderr.toString(), /VM_MEMORY must be a size/);
    assert.match(runVmConfig({ VM_CPUS: '0' }).stderr.toString(), /VM_CPUS must be a positive integer/);
  });
});

describe('production', () => {
  // vm/scripts/build.js runs in the production image without the app's secrets.
  test('loads without the app settings', () => {
    const result = runVmConfig({ NODE_ENV: 'production', SESSION_SECRET: '', RESOURCE_HMAC_SECRET: '' });
    assert.equal(result.status, 0, result.stderr.toString());
  });
});
