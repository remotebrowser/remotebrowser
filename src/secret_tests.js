import test from 'node:test';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecrets } from './secret.js';

describe('parseSecrets', () => {
  test('splits a comma-separated list into an array', () => {
    assert.deepEqual(parseSecrets('alpha,beta,gamma'), ['alpha', 'beta', 'gamma']);
  });

  test('trims surrounding whitespace around each secret', () => {
    assert.deepEqual(parseSecrets(' alpha ,  beta  ,gamma '), ['alpha', 'beta', 'gamma']);
  });

  test('returns a single-element array for a single secret', () => {
    assert.deepEqual(parseSecrets('alpha'), ['alpha']);
  });

  test('drops empty entries from stray commas', () => {
    assert.deepEqual(parseSecrets('alpha,,gamma,'), ['alpha', 'gamma']);
  });

  test('returns an empty array for an unset value', () => {
    assert.deepEqual(parseSecrets(undefined), []);
  });

  test('returns an empty array for an empty string', () => {
    assert.deepEqual(parseSecrets(''), []);
  });
});
