import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Seed env vars before config.js loads so tests use a known-good config; two comma-separated secrets so previousSessionSecret is populated below.
Object.assign(process.env, {
  SESSION_SECRET: `${'a'.repeat(64)},${'b'.repeat(64)}`
});

const { config } = await import('../config.js');
const { signWith, sign, signatureMatches } = await import('./signing.js');

test('signWith produces the HMAC-SHA256 base64url digest of the value under the given secret', () => {
  const secret = Buffer.from('c'.repeat(64), 'hex');
  const expected = crypto.createHmac('sha256', secret).update('hello').digest('base64url');
  assert.equal(signWith(secret, 'hello'), expected);
});

test('sign is deterministic for the same value and differs for different values', () => {
  assert.equal(sign('payload'), sign('payload'));
  assert.notEqual(sign('payload'), sign('other-payload'));
});

test('sign uses the configured session secret', () => {
  const expected = crypto.createHmac('sha256', config.sessionSecret).update('payload').digest('base64url');
  assert.equal(sign('payload'), expected);
});

test('signatureMatches returns true for a signature produced by sign', () => {
  assert.ok(signatureMatches('payload', sign('payload')));
});

test('signatureMatches returns false when the payload has been tampered with', () => {
  const signature = sign('payload');
  assert.equal(signatureMatches('tampered-payload', signature), false);
});

test('signatureMatches returns false for a garbage signature', () => {
  assert.equal(signatureMatches('payload', 'not-a-real-signature'), false);
});

test('signatureMatches accepts a signature produced with the previous session secret', () => {
  const signature = signWith(config.previousSessionSecret, 'payload');
  assert.ok(signatureMatches('payload', signature));
});

test('signatureMatches rejects a signature produced with neither the current nor previous secret', () => {
  const signature = signWith(Buffer.from('d'.repeat(64), 'hex'), 'payload');
  assert.equal(signatureMatches('payload', signature), false);
});
