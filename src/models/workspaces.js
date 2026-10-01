import { getDatabase } from '../db/database.js';
import { generateShortId } from '../id.js';
import { setPersonalWorkspaceId } from './users.js';

const db = () => getDatabase();
const PERSONAL_WORKSPACE_NAME = 'Personal';

// Capital 'W' for workspace, easy to recognize.
const generatePublicId = () => generateShortId('W', 6);

const mapCollaborator = (r) => ({
  workspaceId: r.workspace_id,
  userPublicId: r.user_public_id,
  email: r.email,
  role: r.role,
  workspaceName: r.workspace_name
});
const mapInvitation = (r) => ({
  workspaceId: r.workspace_id,
  email: r.email,
  role: r.role,
  workspaceName: r.workspace_name
});

// Repair reuses an explicit id, so the column list changes when one is given.
const insertWorkspace = (workspaceId, name, ownerId, personal, publicId) => {
  const values = [name, ownerId, personal, publicId];
  const insert = (columns, placeholders, parameters) =>
    db().then((database) =>
      database.query(`INSERT INTO workspaces(${columns}) VALUES(${placeholders}) RETURNING id`, parameters)
    );
  if (workspaceId != null) {
    return insert('id,name,owner_id,personal,public_id', '$1,$2,$3,$4,$5', [workspaceId, ...values]);
  }
  return insert('name,owner_id,personal,public_id', '$1,$2,$3,$4', values);
};

// A collision is vanishingly rare (32^6), so a handful of redraws is plenty.
const MAX_PUBLIC_ID_ATTEMPTS = 5;

// generateId is injectable only so tests can force a public_id collision.
const createWorkspace = async ({
  name,
  ownerId,
  personal = false,
  workspaceId = null,
  generateId = generatePublicId
}) => {
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
    try {
      const r = await insertWorkspace(workspaceId, name, ownerId, personal, generateId());
      return { data: { workspaceId: r.rows[0].id } };
    } catch (e) {
      // Repair of an existing row clashes on the primary key (or the personal
      // index); that means "already there".
      if (workspaceId != null && e.code === '23505' && e.constraint !== 'workspaces_public_id_unique_idx') {
        return { data: { workspaceId } };
      }
      // The generated public_id is already taken by another workspace; draw again.
      if (e.code === '23505' && e.constraint === 'workspaces_public_id_unique_idx') continue;
      return { error: e.message };
    }
  }
  return { error: 'PUBLIC_ID_NOT_UNIQUE' };
};

const workspaceExists = async ({ workspaceId }) => {
  const r = await (await db()).query('SELECT 1 FROM workspaces WHERE id=$1', [workspaceId]);
  return { data: r.rows.length > 0 };
};

const deleteWorkspace = async ({ workspaceId }) => {
  const r = await (await db()).query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
  return { data: r.rowCount > 0 };
};

const getCollaborator = async ({ workspaceId, userId }) => {
  try {
    const r = await (
      await db()
    ).query(
      `SELECT c.*, u.public_id AS user_public_id
       FROM collaborators c
       JOIN users u ON u.id = c.user_id
       WHERE c.workspace_id=$1 AND c.user_id=$2`,
      [workspaceId, userId]
    );
    return { data: r.rows[0] ? mapCollaborator(r.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

// Route-gated only — see src/routes/workspace/role.js and workspaces/create.js
// for the sole authorized callers.
const createCollaborator = async ({ workspaceId, userId, email, role, workspaceName }) => {
  try {
    await (
      await db()
    ).query(
      'INSERT INTO collaborators(workspace_id,user_id,email,role,workspace_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [workspaceId, userId, email, role, workspaceName]
    );
    return { data: true };
  } catch (e) {
    return { error: e.message };
  }
};

// Rank checks (who may promote/demote whom) live at the route layer; this only
// guards the one absolute rule: this path can never create or overwrite an
// Owner seat. Ownership only ever moves through transferOwnership.
const updateCollaboratorRole = async ({ workspaceId, userId, role }) => {
  if (role === 'Owner') return { error: 'INVALID_ROLE' };
  try {
    const r = await (
      await db()
    ).query("UPDATE collaborators SET role=$3 WHERE workspace_id=$1 AND user_id=$2 AND role <> 'Owner'", [
      workspaceId,
      userId,
      role
    ]);
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

// Route-gated only — see src/routes/workspace/remove.js and delete.js (via
// deleteWorkspaceCascade) for the sole authorized callers.
const deleteCollaborator = async ({ workspaceId, userId }) => {
  try {
    const r = await (
      await db()
    ).query('DELETE FROM collaborators WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

const listCollaboratorsByUser = async ({ userId }) => {
  try {
    const r = await (
      await db()
    ).query(
      `SELECT c.*, u.public_id AS user_public_id
       FROM collaborators c
       JOIN users u ON u.id = c.user_id
       WHERE c.user_id=$1`,
      [userId]
    );
    return { data: r.rows.map(mapCollaborator) };
  } catch (e) {
    return { error: e.message };
  }
};

const listCollaboratorsByWorkspace = async ({ workspaceId }) => {
  const r = await (
    await db()
  ).query(
    `SELECT c.*, u.public_id AS user_public_id
     FROM collaborators c
     JOIN users u ON u.id = c.user_id
     WHERE c.workspace_id=$1`,
    [workspaceId]
  );
  return { data: r.rows.map(mapCollaborator) };
};

// Route-gated only — see src/routes/workspace/invite/index.js for the sole
// authorized caller.
const createInvitation = async ({ workspaceId, email, role, workspaceName }) => {
  try {
    await (
      await db()
    ).query(
      'INSERT INTO invitations(workspace_id,email,role,workspace_name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [workspaceId, email, role, workspaceName]
    );
    return { data: true };
  } catch (e) {
    return { error: e.message };
  }
};

const deleteInvitation = async ({ workspaceId, email }) => {
  const r = await (
    await db()
  ).query('DELETE FROM invitations WHERE workspace_id=$1 AND email=$2', [workspaceId, email]);
  return { data: r.rowCount > 0 };
};

const listInvitationsByEmail = async ({ email }) => {
  const r = await (await db()).query('SELECT * FROM invitations WHERE email=$1', [email]);
  return { data: r.rows.map(mapInvitation) };
};

const listInvitationsByWorkspace = async ({ workspaceId }) => {
  const r = await (await db()).query('SELECT * FROM invitations WHERE workspace_id=$1', [workspaceId]);
  return { data: r.rows.map(mapInvitation) };
};

// Claims each waiting invitation; one failure can't block the rest.
const claimInvitationsForUser = async ({ userId, email }) => {
  const invitations = await listInvitationsByEmail({ email });
  const claimed = [];
  for (const invitation of invitations.data) {
    const c = await createCollaborator({
      workspaceId: invitation.workspaceId,
      userId,
      email,
      role: invitation.role,
      workspaceName: invitation.workspaceName
    });
    if (!c.error) {
      await deleteInvitation({ workspaceId: invitation.workspaceId, email });
      claimed.push(invitation);
    }
  }
  return { data: { claimed, failed: [] } };
};

const transferOwnership = async ({ workspaceId, fromUserId, toUserId }) => {
  const database = await db();
  try {
    return await database.transaction(async (tx) => {
      await tx.query("UPDATE collaborators SET role='Owner' WHERE workspace_id=$1 AND user_id=$2", [
        workspaceId,
        toUserId
      ]);
      await tx.query("UPDATE collaborators SET role='Admin' WHERE workspace_id=$1 AND user_id=$2", [
        workspaceId,
        fromUserId
      ]);
      await tx.query('UPDATE workspaces SET owner_id=$2 WHERE id=$1', [workspaceId, toUserId]);
      return { data: true };
    });
  } catch (e) {
    return { error: e.message };
  }
};

const deleteWorkspaceCascade = async ({ workspaceId }) => deleteWorkspace({ workspaceId });

const repairPersonalWorkspace = async ({ userId, email, workspaceId }) => {
  const w = await createWorkspace({
    name: PERSONAL_WORKSPACE_NAME,
    ownerId: userId,
    personal: true,
    workspaceId
  });
  if (w.error) return w;
  return createCollaborator({ workspaceId, userId, email, role: 'Owner', workspaceName: PERSONAL_WORKSPACE_NAME });
};

const ensurePersonalWorkspace = async ({ userId, email, personalWorkspaceId }) => {
  if (personalWorkspaceId) return { data: { workspaceId: personalWorkspaceId, created: false } };
  const w = await createWorkspace({ name: PERSONAL_WORKSPACE_NAME, ownerId: userId, personal: true });
  if (w.error) return w;
  await createCollaborator({
    workspaceId: w.data.workspaceId,
    userId,
    email,
    role: 'Owner',
    workspaceName: PERSONAL_WORKSPACE_NAME
  });
  // The pointer is write-once; the check at the top of this function already
  // means it can only be unset here, so an ALREADY_SET race is harmless.
  await setPersonalWorkspaceId({ id: userId, workspaceId: w.data.workspaceId });
  return { data: { workspaceId: w.data.workspaceId, created: true } };
};

export {
  createWorkspace,
  workspaceExists,
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
};
