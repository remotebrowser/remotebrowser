import { getDatabase } from '../db/database.js';
import { generateShortId } from '../id.js';
import { workspaceExists, repairPersonalWorkspace } from './workspaces.js';
import { generateBrowserHandle } from '../handle.js';
import { isWellFormedBrowserId } from '../fleet.js';

const db = () => getDatabase();

// Capital 'B' for browser, easy to recognize.
const generatePublicId = () => generateShortId('B', 6);

const map = (r) => ({
  browserInstanceId: r.id,
  publicId: r.public_id,
  browserName: r.browser_name,
  status: r.status,
  browserHandle: r.browser_handle,
  internalBrowserId: r.internal_browser_id,
  creatorUserId: r.user_id,
  createdTimestamp: Number(r.created_timestamp)
});

// Repairs a deleted personal workspace before the query runs; a browser count
// of zero is a valid answer, so there is no failure signal to retry after.
const ensureWorkspaceForRepair = async (workspaceId, repair) => {
  if (!repair) return;
  const exists = await workspaceExists({ workspaceId });
  if (!exists.data) {
    await repairPersonalWorkspace({ workspaceId, ...repair });
  }
};

// A collision is vanishingly rare (32^6), so a handful of redraws is plenty.
const MAX_PUBLIC_ID_ATTEMPTS = 5;

// generateId is injectable only so tests can force a public_id collision.
const launchBrowserInstance = async ({
  workspaceId,
  userId,
  browserName,
  browserDescription,
  personalWorkspaceRepair,
  generateId = generatePublicId,
  now = Date.now()
}) => {
  await ensureWorkspaceForRepair(workspaceId, personalWorkspaceRepair);
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
    try {
      // Issued before the insert so the row always names a valid browser.
      const browserHandle = generateBrowserHandle();
      const r = await (
        await db()
      ).query(
        `INSERT INTO browser_instances(workspace_id,browser_name,browser_description,status,user_id,internal_browser_id,browser_handle,config,public_id,created_timestamp) VALUES($1,$2,$3,'starting',$4,'',$5,NULL,$6,$7) RETURNING id, public_id`,
        [workspaceId, browserName, browserDescription || '', userId, browserHandle, generateId(), now]
      );
      return { data: { browserInstanceId: r.rows[0].id, publicId: r.rows[0].public_id } };
    } catch (e) {
      // The generated public_id is already taken by another browser; draw again.
      if (e.code === '23505' && e.constraint === 'browser_instances_public_id_unique_idx') continue;
      return { error: e.message };
    }
  }
  return { error: 'PUBLIC_ID_NOT_UNIQUE' };
};

// Writes the fleet's internal id onto the instance row, for the owner only. The
// field must still be empty, so a second call (a bug, or a replayed request)
// can't silently re-point an already-provisioned browser.
const recordProvisionedBrowser = async ({ workspaceId, browserInstanceId, internalBrowserId, userId }) => {
  // Defence in depth: nothing unsafe should reach storage, since the value builds request URLs.
  if (!isWellFormedBrowserId(internalBrowserId)) {
    return { error: 'INVALID_BROWSER_ID' };
  }
  const r = await (
    await db()
  ).query(
    `UPDATE browser_instances SET internal_browser_id=$3
     WHERE workspace_id=$1 AND id=$2 AND user_id=$4 AND internal_browser_id=''`,
    [workspaceId, browserInstanceId, internalBrowserId, userId]
  );
  if (r.rowCount > 0) return { data: true };
  // Nothing updated: separate "not the owner" from "already provisioned".
  const owned = await (
    await db()
  ).query('SELECT 1 FROM browser_instances WHERE workspace_id=$1 AND id=$2 AND user_id=$3', [
    workspaceId,
    browserInstanceId,
    userId
  ]);
  return { error: owned.rows[0] ? 'ALREADY_PROVISIONED' : 'NOT_AUTHORIZED' };
};

const updateBrowserInstanceStatus = async ({ workspaceId, browserInstanceId, toStatus }) => {
  const r = await (
    await db()
  ).query('UPDATE browser_instances SET status=$3 WHERE workspace_id=$1 AND id=$2', [
    workspaceId,
    browserInstanceId,
    toStatus
  ]);
  return { data: r.rowCount > 0 };
};

const deleteBrowserInstance = async ({ workspaceId, browserInstanceId }) => {
  const r = await (
    await db()
  ).query('DELETE FROM browser_instances WHERE workspace_id=$1 AND id=$2', [workspaceId, browserInstanceId]);
  return { data: r.rowCount > 0 };
};

// Every browser that has a fleet id, across all workspaces: the monitors to
// restore at startup. Unprovisioned rows have nothing to attach to.
const listProvisionedBrowserInstances = async () => {
  const r = await (
    await db()
  ).query("SELECT id, workspace_id, internal_browser_id FROM browser_instances WHERE internal_browser_id <> ''");
  return {
    data: r.rows.map((row) => ({
      workspaceId: row.workspace_id,
      browserInstanceId: row.id,
      internalBrowserId: row.internal_browser_id
    }))
  };
};

// Every row that still holds a capacity slot: what the reconciler checks
// against the fleet.
const listActiveBrowserInstances = async () => {
  try {
    const r = await (
      await db()
    ).query(
      "SELECT id, workspace_id, internal_browser_id, created_timestamp FROM browser_instances WHERE status <> 'terminated' ORDER BY id"
    );
    return {
      data: r.rows.map((row) => ({
        workspaceId: row.workspace_id,
        browserInstanceId: row.id,
        internalBrowserId: row.internal_browser_id,
        createdTimestamp: Number(row.created_timestamp)
      }))
    };
  } catch (e) {
    return { error: e.message };
  }
};

// Matching on the fleet id the caller saw means a row provisioned since the
// read is not terminated by a stale decision.
const markBrowserInstanceTerminated = async ({ workspaceId, browserInstanceId, internalBrowserId }) => {
  try {
    const r = await (
      await db()
    ).query(
      "UPDATE browser_instances SET status='terminated' WHERE workspace_id=$1 AND id=$2 AND internal_browser_id=$3 AND status <> 'terminated'",
      [workspaceId, browserInstanceId, internalBrowserId]
    );
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

const listBrowserInstancesByWorkspace = async ({ workspaceId, personalWorkspaceRepair }) => {
  await ensureWorkspaceForRepair(workspaceId, personalWorkspaceRepair);
  const r = await (
    await db()
  ).query('SELECT * FROM browser_instances WHERE workspace_id=$1 ORDER BY id DESC', [workspaceId]);
  return { data: r.rows.map(map) };
};

const getBrowserInstance = async ({ workspaceId, browserInstanceId, personalWorkspaceRepair }) => {
  await ensureWorkspaceForRepair(workspaceId, personalWorkspaceRepair);
  const r = await (
    await db()
  ).query('SELECT * FROM browser_instances WHERE workspace_id=$1 AND id=$2', [workspaceId, browserInstanceId]);
  return { data: r.rows[0] ? map(r.rows[0]) : null };
};

// The public id is what the URL carries, so resolving it back to the numeric
// key happens here, at the edge of the model.
const getBrowserInstanceByPublicId = async ({ workspaceId, publicId, personalWorkspaceRepair }) => {
  await ensureWorkspaceForRepair(workspaceId, personalWorkspaceRepair);
  const r = await (
    await db()
  ).query('SELECT * FROM browser_instances WHERE workspace_id=$1 AND public_id=$2', [workspaceId, publicId]);
  return { data: r.rows[0] ? map(r.rows[0]) : null };
};

const browserIdForHandle = async ({ handle }) => {
  if (typeof handle !== 'string' || !handle || /[/?#%]/.test(handle)) return { data: null };
  const r = await (
    await db()
  ).query('SELECT internal_browser_id FROM browser_instances WHERE browser_handle=$1', [handle]);
  return { data: r.rows[0]?.internal_browser_id || null };
};

export {
  launchBrowserInstance,
  recordProvisionedBrowser,
  updateBrowserInstanceStatus,
  deleteBrowserInstance,
  listBrowserInstancesByWorkspace,
  listProvisionedBrowserInstances,
  listActiveBrowserInstances,
  markBrowserInstanceTerminated,
  getBrowserInstance,
  getBrowserInstanceByPublicId,
  browserIdForHandle
};
