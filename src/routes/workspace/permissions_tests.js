import test from 'node:test';
import assert from 'node:assert/strict';
import { outranks, canTransferOwnership } from './permissions.js';

test('outranks: an Owner always outranks another role', () => {
  assert.equal(outranks({ actingRole: 'Owner', targetRole: 'Admin' }), true);
  assert.equal(outranks({ actingRole: 'Owner', targetRole: 'Owner' }), true);
});

test('outranks: an Admin outranks a User but not another Admin', () => {
  assert.equal(outranks({ actingRole: 'Admin', targetRole: 'User' }), true);
  assert.equal(outranks({ actingRole: 'Admin', targetRole: 'Admin' }), false);
});

test('outranks: a User never outranks anyone', () => {
  assert.equal(outranks({ actingRole: 'User', targetRole: 'User' }), false);
});

test('canTransferOwnership only refuses the acting user as the target', () => {
  assert.equal(canTransferOwnership({ actingUserPublicId: 'abcdefghi', targetPublicId: 'jklmnopqr' }), true);
  assert.equal(canTransferOwnership({ actingUserPublicId: 'abcdefghi', targetPublicId: 'abcdefghi' }), false);
});
