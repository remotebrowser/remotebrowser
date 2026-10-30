import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOs } from './os.js';

test('resolveOs takes an OS name in any case, with or without the dash, or the short ubuntu', () => {
  for (const name of ['debian-13', 'Debian-13', 'debian13', 'DEBIAN13']) {
    assert.equal(resolveOs(name), 'debian-13', name);
  }
  for (const name of ['ubuntu-26.04', 'ubuntu26.04', 'Ubuntu', 'UBUNTU']) {
    assert.equal(resolveOs(name), 'ubuntu-26.04', name);
  }
});

test('resolveOs refuses any other name, or a value that is not a string', () => {
  for (const name of ['debian', 'ubuntu-24.04', 'windows-11', ' ubuntu', '', 'toString', 13, null, undefined]) {
    assert.equal(resolveOs(name), null, String(name));
  }
});
