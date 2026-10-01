import test from 'node:test';
import assert from 'node:assert/strict';
import { FRIENDLY_CHARS } from './id.js';
import { encodeBase32 } from './base32.js';

const ALPHABET = new RegExp(`^[${FRIENDLY_CHARS}]*$`);

test('encodeBase32 emits only characters from the friendly alphabet', () => {
  for (const length of [0, 1, 5, 20]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 256));
    assert.match(encodeBase32(bytes), ALPHABET);
  }
});

test('encodeBase32 produces 8 characters (5 bits each) for 5 bytes (40 bits)', () => {
  assert.equal(encodeBase32(Buffer.alloc(5)).length, 8);
});

test('encodeBase32 is deterministic', () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(encodeBase32(bytes), encodeBase32(Buffer.from(bytes)));
});

test("encodeBase32 maps an all-zero byte to the alphabet's first character, repeated", () => {
  assert.equal(encodeBase32(Buffer.alloc(5)), FRIENDLY_CHARS[0].repeat(8));
});

test('encodeBase32 distinguishes inputs that differ only in trailing bits', () => {
  assert.notEqual(encodeBase32(Buffer.from([0xff])), encodeBase32(Buffer.from([0x00])));
});
