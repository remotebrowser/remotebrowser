import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const {
  createWorkspace,
  PERSONAL_WORKSPACE_NAME,
  ensurePersonalWorkspace,
  repairPersonalWorkspace,
  deleteWorkspace,
  getCollaborator,
  createCollaborator,
  updateCollaboratorRole,
  deleteCollaborator,
  listCollaboratorsByUser,
  listCollaboratorsByWorkspace,
  createInvitation,
  deleteInvitation,
  listInvitationsByEmail,
  listInvitationsByWorkspace,
  claimInvitationsForUser,
  transferOwnership,
  deleteWorkspaceCascade
} = await import('./workspaces.js');
const { findOrCreateUser } = await import('./users.js');
const { generateShortId } = await import('../id.js');
const { getDatabase, closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

// Workspaces, collaborators and invitations all FK back to users, so every
// test needs its owners created first.
const makeUser = async (email) => (await findOrCreateUser({ email })).data.id;

const workspacePublicId = async (workspaceId) =>
  (await (await getDatabase()).query('SELECT public_id FROM workspaces WHERE id=$1', [workspaceId])).rows[0].public_id;

test('createWorkspace generates an id, and repairs at a fixed id idempotently', async () => {
  const ownerId = await makeUser('owner1@example.com');

  const generated = await createWorkspace({ name: 'Team', ownerId });
  assert.equal(generated.error, undefined);
  assert.ok(Number.isSafeInteger(generated.data.workspaceId));

  const first = await createWorkspace({
    name: PERSONAL_WORKSPACE_NAME,
    ownerId,
    personal: true,
    workspaceId: 2345
  });
  assert.deepEqual(first, { data: { workspaceId: 2345 } });

  // Same id again: a real collision must read as "already there", not an error.
  const repaired = await createWorkspace({
    name: PERSONAL_WORKSPACE_NAME,
    ownerId,
    personal: true,
    workspaceId: 2345
  });
  assert.deepEqual(repaired, { data: { workspaceId: 2345 } });
});

test('createWorkspace assigns a friendly 6-character public id prefixed with W', async () => {
  const ownerId = await makeUser('owner@example.com');
  const created = await createWorkspace({ name: 'Team', ownerId });
  assert.match(await workspacePublicId(created.data.workspaceId), /^W[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
});

test('createWorkspace regenerates the public id when the drawn one is taken', async () => {
  const ownerId = await makeUser('owner@example.com');
  const first = await createWorkspace({ name: 'First', ownerId });
  const taken = await workspacePublicId(first.data.workspaceId);

  let calls = 0;
  const generateId = () => (calls++ === 0 ? taken : generateShortId('W', 6));
  const second = await createWorkspace({ name: 'Second', ownerId, generateId });

  assert.equal(second.error, undefined);
  assert.equal(calls, 2, 'the collision must trigger exactly one redraw');
  assert.notEqual(await workspacePublicId(second.data.workspaceId), taken);
});

test('deleteWorkspace reports whether a row existed', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const created = await createWorkspace({ name: 'Team', ownerId });

  assert.deepEqual(await deleteWorkspace({ workspaceId: 999999 }), { data: false });
  assert.deepEqual(await deleteWorkspace({ workspaceId: created.data.workspaceId }), { data: true });
});

test('collaborators can be created, fetched, updated and removed', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const memberId = await makeUser('member1@example.com');
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  const workspaceId = workspace.data.workspaceId;

  assert.deepEqual(await getCollaborator({ workspaceId, userId: memberId }), { data: null });

  const created = await createCollaborator({
    workspaceId,
    userId: memberId,
    email: 'member1@example.com',
    role: 'User',
    workspaceName: 'Team'
  });
  assert.deepEqual(created, { data: true });

  const fetched = await getCollaborator({ workspaceId, userId: memberId });
  assert.equal(fetched.data.role, 'User');
  assert.equal(fetched.data.email, 'member1@example.com');

  assert.deepEqual(await updateCollaboratorRole({ workspaceId, userId: memberId, role: 'Admin' }), { data: true });
  assert.equal((await getCollaborator({ workspaceId, userId: memberId })).data.role, 'Admin');

  const byUser = await listCollaboratorsByUser({ userId: memberId });
  assert.equal(byUser.data.length, 1);
  const byWorkspace = await listCollaboratorsByWorkspace({ workspaceId });
  assert.equal(byWorkspace.data.length, 1);

  assert.deepEqual(await deleteCollaborator({ workspaceId, userId: memberId }), { data: true });
  assert.deepEqual(await getCollaborator({ workspaceId, userId: memberId }), { data: null });
});

test('updateCollaboratorRole never creates or overwrites an Owner seat', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const memberId = await makeUser('member1@example.com');
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  const workspaceId = workspace.data.workspaceId;
  await createCollaborator({
    workspaceId,
    userId: ownerId,
    email: 'owner1@example.com',
    role: 'Owner',
    workspaceName: 'Team'
  });
  await createCollaborator({
    workspaceId,
    userId: memberId,
    email: 'member1@example.com',
    role: 'User',
    workspaceName: 'Team'
  });

  // Can't promote a collaborator to Owner through this path...
  assert.deepEqual(await updateCollaboratorRole({ workspaceId, userId: memberId, role: 'Owner' }), {
    error: 'INVALID_ROLE'
  });
  assert.equal((await getCollaborator({ workspaceId, userId: memberId })).data.role, 'User');

  // ...nor demote the existing Owner.
  assert.deepEqual(await updateCollaboratorRole({ workspaceId, userId: ownerId, role: 'Admin' }), { data: false });
  assert.equal((await getCollaborator({ workspaceId, userId: ownerId })).data.role, 'Owner');
});

test('collaborator reads and writes report a malformed user id as an error', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  const workspaceId = workspace.data.workspaceId;
  const badId = Number('not-a-user-id');

  assert.ok((await getCollaborator({ workspaceId, userId: badId })).error);
  assert.ok((await updateCollaboratorRole({ workspaceId, userId: badId, role: 'Admin' })).error);
  assert.ok((await deleteCollaborator({ workspaceId, userId: badId })).error);
});

test('invitations can be created, listed and claimed into a collaborator seat', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  const workspaceId = workspace.data.workspaceId;

  const created = await createInvitation({
    workspaceId,
    email: 'invitee@example.com',
    role: 'User',
    workspaceName: 'Team'
  });
  assert.deepEqual(created, { data: true });

  assert.equal((await listInvitationsByEmail({ email: 'invitee@example.com' })).data.length, 1);
  assert.equal((await listInvitationsByWorkspace({ workspaceId })).data.length, 1);

  const inviteeId = await makeUser('invitee@example.com');
  const claimed = await claimInvitationsForUser({ userId: inviteeId, email: 'invitee@example.com' });
  assert.equal(claimed.data.claimed.length, 1);
  assert.deepEqual(claimed.data.failed, []);

  // Claiming deletes the invitation and seats the collaborator.
  assert.equal((await listInvitationsByEmail({ email: 'invitee@example.com' })).data.length, 0);
  assert.equal((await getCollaborator({ workspaceId, userId: inviteeId })).data.role, 'User');

  const secondInvite = await createInvitation({
    workspaceId,
    email: 'other@example.com',
    role: 'User',
    workspaceName: 'Team'
  });
  assert.deepEqual(secondInvite, { data: true });
  assert.deepEqual(await deleteInvitation({ workspaceId, email: 'other@example.com' }), { data: true });
});

test('transferOwnership swaps roles and the workspace owner together, atomically', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const memberId = await makeUser('member1@example.com');
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  const workspaceId = workspace.data.workspaceId;
  await createCollaborator({
    workspaceId,
    userId: ownerId,
    email: 'owner1@example.com',
    role: 'Owner',
    workspaceName: 'Team'
  });
  await createCollaborator({
    workspaceId,
    userId: memberId,
    email: 'member1@example.com',
    role: 'User',
    workspaceName: 'Team'
  });

  const result = await transferOwnership({ workspaceId, fromUserId: ownerId, toUserId: memberId });
  assert.deepEqual(result, { data: true });

  assert.equal((await getCollaborator({ workspaceId, userId: memberId })).data.role, 'Owner');
  assert.equal((await getCollaborator({ workspaceId, userId: ownerId })).data.role, 'Admin');
});

test('ensurePersonalWorkspace creates a personal workspace once and reuses the pointer after', async () => {
  const ownerId = await makeUser('owner1@example.com');

  const created = await ensurePersonalWorkspace({
    userId: ownerId,
    email: 'owner1@example.com',
    personalWorkspaceId: null
  });
  assert.equal(created.data.created, true);
  assert.ok(Number.isSafeInteger(created.data.workspaceId));
  assert.equal((await getCollaborator({ workspaceId: created.data.workspaceId, userId: ownerId })).data.role, 'Owner');

  const reused = await ensurePersonalWorkspace({
    userId: ownerId,
    email: 'owner1@example.com',
    personalWorkspaceId: created.data.workspaceId
  });
  assert.deepEqual(reused, { data: { workspaceId: created.data.workspaceId, created: false } });
});

test('repairPersonalWorkspace recreates a deleted personal workspace at its old id', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const repaired = await repairPersonalWorkspace({
    userId: ownerId,
    email: 'owner1@example.com',
    workspaceId: 2345
  });
  assert.deepEqual(repaired, { data: true });
  assert.equal((await getCollaborator({ workspaceId: 2345, userId: ownerId })).data.role, 'Owner');
});

test('deleteWorkspaceCascade is an alias for deleteWorkspace', async () => {
  const ownerId = await makeUser('owner1@example.com');
  const workspace = await createWorkspace({ name: 'Team', ownerId });
  assert.deepEqual(await deleteWorkspaceCascade({ workspaceId: workspace.data.workspaceId }), { data: true });
});
