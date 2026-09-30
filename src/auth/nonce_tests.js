import test from 'node:test';
import assert from 'node:assert/strict';

import { createNonce, parseNonce } from './nonce.js';

test('createNonce/parseNonce round-trip a nonce for the same email', () => {
  const { nonce, token, expires } = createNonce('user@example.com');
  assert.equal(parseNonce('user@example.com', nonce).token, token);
  assert.equal(parseNonce('user@example.com', nonce).expires, expires);
});

test('parseNonce returns null for non-string input', () => {
  assert.equal(parseNonce('user@example.com', undefined), null);
  assert.equal(parseNonce('user@example.com', null), null);
});

test('parseNonce returns null for a nonce without three dot-separated parts', () => {
  assert.equal(parseNonce('user@example.com', 'a.b'), null);
});

test('parseNonce returns null for a tampered nonce', () => {
  const { nonce } = createNonce('user@example.com');
  assert.equal(parseNonce('user@example.com', `${nonce.slice(0, -4)}abcd`), null);
});

test('parseNonce rejects a nonce issued for a different email', () => {
  const { nonce } = createNonce('a@example.com');
  assert.equal(parseNonce('b@example.com', nonce), null);
});

test('parseNonce rejects an expired nonce without any database access', () => {
  const { nonce, expires } = createNonce('user@example.com');
  const expired = nonce.replace(String(expires), String(Date.now() - 1000));
  assert.equal(parseNonce('user@example.com', expired), null);
});

test('createNonce expires around five minutes out', () => {
  const { expires } = createNonce('user@example.com');
  const remaining = expires - Date.now();
  assert.ok(remaining > 4.5 * 60 * 1000 && remaining <= 5 * 60 * 1000, `unexpected remaining ms: ${remaining}`);
});
