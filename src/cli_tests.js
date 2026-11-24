import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  isCliToken,
  isWellFormedCliToken,
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode,
  formatUserCode,
  USER_CODE_ALPHABET
} from './cli.js';
import { generateApiKey, isWellFormedApiKey } from './apikey.js';

test('generateCliToken has a recognizable prefix and verifies', () => {
  const token = generateCliToken();
  assert.ok(token.startsWith('rb-cli-'));
  assert.ok(token.startsWith(CLI_TOKEN_PREFIX));
  assert.ok(isCliToken(token));
  assert.ok(isWellFormedCliToken(token));
  assert.ok(token.length >= CLI_TOKEN_PREFIX.length + 52);
});

test('isWellFormedCliToken refuses a changed token and an API key', () => {
  const token = generateCliToken();
  const last = token.at(-1);
  assert.equal(isWellFormedCliToken(token.slice(0, -1) + (last === '2' ? '3' : '2')), false);
  assert.equal(isWellFormedCliToken(generateApiKey()), false);
  assert.equal(isWellFormedApiKey(token), false);
  assert.equal(isWellFormedCliToken(undefined), false);
});

test('generateDeviceCode is URL-safe and at least 32 bytes', () => {
  const code = generateDeviceCode();
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.from(code, 'base64url').length >= 32);
});

test('generateUserCode uses 8 characters with no look-alikes', () => {
  for (let index = 0; index < 50; index += 1) {
    const code = generateUserCode();
    assert.match(code, new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`));
  }
});

test('normalizeUserCode accepts any case, with or without the dash', () => {
  assert.equal(normalizeUserCode('BDFG-HJKL'), 'BDFGHJKL');
  assert.equal(normalizeUserCode('bdfghjkl'), 'BDFGHJKL');
  assert.equal(normalizeUserCode(' bdfg hjkl '), 'BDFGHJKL');
  assert.equal(normalizeUserCode('BDFG-HJK'), null);
  assert.equal(normalizeUserCode('AEIO-UBCD'), null, 'vowels are not in the alphabet');
  assert.equal(normalizeUserCode(undefined), null);
  assert.equal(formatUserCode('BDFGHJKL'), 'BDFG-HJKL');
});
