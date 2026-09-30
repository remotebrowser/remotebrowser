import test from 'node:test';
import assert from 'node:assert/strict';
import { FRIENDLY_CHARS } from './id.js';
import { generateBrowserHandle, isWellFormedBrowserHandle, BROWSER_HANDLE_LENGTH, HANDLE_PREFIX } from './handle.js';

const { describe } = test;

const ALPHABET = new RegExp(`^[${FRIENDLY_CHARS}]+$`);
const otherChar = (char) => FRIENDLY_CHARS[(FRIENDLY_CHARS.indexOf(char) + 1) % FRIENDLY_CHARS.length];

describe('generateBrowserHandle', () => {
  test('is a fixed-length string of friendly characters, at least 20 of them, with the H prefix', () => {
    const handle = generateBrowserHandle();
    assert.equal(handle.length, BROWSER_HANDLE_LENGTH);
    assert.ok(BROWSER_HANDLE_LENGTH >= 20, `handles must be at least 20 chars, got ${BROWSER_HANDLE_LENGTH}`);
    assert.equal(handle[0], HANDLE_PREFIX);
    assert.match(handle.slice(HANDLE_PREFIX.length), ALPHABET);
  });

  // Nonce is the only defence against guessing; generator must not repeat.
  test('does not repeat', () => {
    const handles = new Set(Array.from({ length: 500 }, () => generateBrowserHandle()));
    assert.equal(handles.size, 500);
  });

  test('produces handles that verify', () => {
    for (let index = 0; index < 20; index += 1) {
      const handle = generateBrowserHandle();
      assert.ok(isWellFormedBrowserHandle(handle), `${handle} did not verify`);
    }
  });
});

describe('isWellFormedBrowserHandle', () => {
  test('rejects a tampered MAC', () => {
    const handle = generateBrowserHandle();
    assert.equal(isWellFormedBrowserHandle(handle.slice(0, -1) + otherChar(handle.at(-1))), false);
  });

  test('rejects a tampered nonce', () => {
    const handle = generateBrowserHandle();
    assert.equal(isWellFormedBrowserHandle(handle.slice(0, 2) + otherChar(handle[2]) + handle.slice(3)), false);
  });

  test('rejects a missing or wrong prefix', () => {
    const handle = generateBrowserHandle();
    assert.equal(isWellFormedBrowserHandle(handle.slice(1)), false, 'missing prefix');
    assert.equal(isWellFormedBrowserHandle(`${otherChar('2')}${handle.slice(1)}`), false, 'wrong prefix');
  });

  test('rejects anything of the wrong length', () => {
    const handle = generateBrowserHandle();
    assert.equal(isWellFormedBrowserHandle(handle.slice(0, -1)), false, 'short');
    assert.equal(isWellFormedBrowserHandle(`${handle}a`), false, 'long');
  });

  test('rejects characters outside the friendly alphabet', () => {
    const handle = generateBrowserHandle();
    for (const char of ['0', '1', 'l', 'o', 'A', '-', '/', '%']) {
      assert.equal(isWellFormedBrowserHandle(handle.slice(0, -1) + char), false, `for ${char}`);
    }
  });

  test('rejects empty and non-string input', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.equal(isWellFormedBrowserHandle(bad), false, `for ${JSON.stringify(bad)}`);
    }
  });
});
