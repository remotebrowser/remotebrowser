import test from 'node:test';
import assert from 'node:assert/strict';
import { formString } from './form.js';

test('formString returns the value unchanged when it is a string', () => {
  assert.equal(formString('hello'), 'hello');
});

test('formString returns an empty string for non-string values', () => {
  assert.equal(formString(undefined), '');
  assert.equal(formString(null), '');
  assert.equal(formString(42), '');
  assert.equal(formString(['a']), '');
});
