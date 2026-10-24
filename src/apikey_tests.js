import test from 'node:test';
import assert from 'node:assert/strict';
import { FRIENDLY_CHARS } from './id.js';
import { generateBrowserHandle } from './handle.js';
import {
  generateApiKey,
  isWellFormedApiKey,
  hashApiKey,
  previewApiKey,
  API_KEY_LENGTH,
  API_KEY_PREFIX
} from './apikey.js';

const { describe } = test;

const ALPHABET = new RegExp(`^[${FRIENDLY_CHARS}]+$`);
const otherChar = (char) => FRIENDLY_CHARS[(FRIENDLY_CHARS.indexOf(char) + 1) % FRIENDLY_CHARS.length];

describe('generateApiKey', () => {
  test('is sk-rb-v1- followed by a fixed number of friendly characters', () => {
    const key = generateApiKey();
    assert.equal(API_KEY_PREFIX, 'sk-rb-v1-');
    assert.equal(key.length, API_KEY_LENGTH);
    assert.ok(key.startsWith(API_KEY_PREFIX));
    assert.match(key.slice(API_KEY_PREFIX.length), ALPHABET);
  });

  test('does not repeat', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey()));
    assert.equal(keys.size, 500);
  });

  test('produces keys that verify', () => {
    for (let index = 0; index < 20; index += 1) {
      const key = generateApiKey();
      assert.ok(isWellFormedApiKey(key), `${key} did not verify`);
    }
  });
});

describe('isWellFormedApiKey', () => {
  test('rejects a tampered MAC', () => {
    const key = generateApiKey();
    assert.equal(isWellFormedApiKey(key.slice(0, -1) + otherChar(key.at(-1))), false);
  });

  test('rejects a tampered nonce', () => {
    const key = generateApiKey();
    const index = API_KEY_PREFIX.length + 1;
    assert.equal(isWellFormedApiKey(key.slice(0, index) + otherChar(key[index]) + key.slice(index + 1)), false);
  });

  test('rejects a missing or wrong prefix', () => {
    const key = generateApiKey();
    const body = key.slice(API_KEY_PREFIX.length);
    assert.equal(isWellFormedApiKey(body), false, 'missing prefix');
    assert.equal(isWellFormedApiKey(`sk-rb-v2-${body}`), false, 'wrong version');
  });

  test('rejects anything of the wrong length', () => {
    const key = generateApiKey();
    assert.equal(isWellFormedApiKey(key.slice(0, -1)), false, 'short');
    assert.equal(isWellFormedApiKey(`${key}a`), false, 'long');
  });

  test('rejects characters outside the friendly alphabet', () => {
    const key = generateApiKey();
    for (const char of ['0', '1', 'l', 'o', 'A', '-', '/', '%']) {
      assert.equal(isWellFormedApiKey(key.slice(0, -1) + char), false, `for ${char}`);
    }
  });

  // The MAC is tagged, so a browser handle's body cannot be replayed as a key.
  test('rejects a browser handle wearing the API key prefix', () => {
    const handle = generateBrowserHandle();
    assert.equal(isWellFormedApiKey(API_KEY_PREFIX + handle.slice(1)), false);
  });

  test('rejects empty and non-string input', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.equal(isWellFormedApiKey(bad), false, `for ${JSON.stringify(bad)}`);
    }
  });
});

describe('hashApiKey and previewApiKey', () => {
  test('the hash is a stable SHA-256 hex digest that does not contain the key', () => {
    const key = generateApiKey();
    assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
    assert.equal(hashApiKey(key), hashApiKey(key));
    assert.notEqual(hashApiKey(key), hashApiKey(generateApiKey()));
  });

  test('the preview keeps the prefix and only a few characters', () => {
    const key = generateApiKey();
    assert.equal(previewApiKey(key), `${key.slice(0, API_KEY_PREFIX.length + 4)}…`);
  });
});
