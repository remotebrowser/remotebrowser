import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isAlive } from './host.js';

const MARKER = 'host-tests-marker';

test('isAlive accepts a running process whose command line has the marker', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', MARKER]);
  try {
    assert.equal(await isAlive(child.pid, MARKER), true);
    assert.equal(await isAlive(child.pid, 'another-marker'), false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('isAlive rejects a process that has exited', async () => {
  const child = spawn(process.execPath, ['-e', '', MARKER]);
  await once(child, 'exit');
  assert.equal(await isAlive(child.pid, MARKER), false);
});
