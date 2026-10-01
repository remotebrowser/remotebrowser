import test from 'node:test';
import assert from 'node:assert/strict';

import { generateShortId } from './id.js';

const FRIENDLY_CHARS_PATTERN = /^[23456789abcdefghijkmnpqrstuvwxyz]+$/;

test('generateShortId defaults to a 5-character id with no prefix', () => {
  const id = generateShortId();
  assert.equal(id.length, 5);
  assert.match(id, FRIENDLY_CHARS_PATTERN);
});

test('generateShortId prepends the given prefix', () => {
  const id = generateShortId('usr_');
  assert.equal(id.length, 'usr_'.length + 5);
  assert.ok(id.startsWith('usr_'));
});

test('generateShortId honors a custom length', () => {
  const id = generateShortId('', 10);
  assert.equal(id.length, 10);
  assert.match(id, FRIENDLY_CHARS_PATTERN);
});

test('generateShortId only uses characters from the friendly alphabet', () => {
  const id = generateShortId('', 200);
  assert.match(id, FRIENDLY_CHARS_PATTERN);
});

test('generateShortId produces distinct ids across calls', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateShortId()));
  assert.equal(ids.size, 50);
});
