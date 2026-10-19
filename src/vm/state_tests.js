import test from 'node:test';
import assert from 'node:assert/strict';
import { isWellFormedBrowserId } from './state.js';

test('isWellFormedBrowserId accepts path-safe ids and rejects traversal', () => {
  assert.equal(isWellFormedBrowserId('Qabc12345'), true);
  assert.equal(isWellFormedBrowserId('a/../b'), false);
});
