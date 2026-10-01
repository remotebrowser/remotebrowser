import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmailAddress } from './email.js';

test('isEmailAddress accepts ordinary addresses, including tagged local parts', () => {
  for (const value of [
    'a@b.com',
    'user@example.com',
    'first.last@example.co.uk',
    'user+tag@example.com',
    "o'brien@example.com",
    'user_name-1@sub.example.com'
  ]) {
    assert.equal(isEmailAddress(value), true, `expected ${value} to be accepted`);
  }
});

test('isEmailAddress rejects addresses that are not addresses', () => {
  for (const value of ['', 'user', 'user@', '@example.com', 'user@example', 'a b@example.com', 'user@exam ple.com']) {
    assert.equal(isEmailAddress(value), false, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

// Address is part of the invitations table's composite key and appears in
// URLs (e.g. the invite-sent confirmation page); reject characters that would
// be unsafe in either.
test('isEmailAddress rejects unsafe path and query characters', () => {
  for (const value of [
    '../../Collaborators/Tabcd_uid@example.com',
    'user@example.com?currentDocument.exists=true',
    'user@example.com#',
    'user%2f@example.com',
    'a/b@example.com',
    'user@exa/mple.com'
  ]) {
    assert.equal(isEmailAddress(value), false, `expected ${value} to be rejected`);
  }
});

test('isEmailAddress rejects non-strings', () => {
  for (const value of [undefined, null, 42, {}, ['a@b.com']]) {
    assert.equal(isEmailAddress(value), false);
  }
});
