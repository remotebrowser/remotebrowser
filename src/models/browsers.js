import { getDatabase } from '../db/database.js';
import { generateShortId } from '../id.js';
import { workspaceExists, repairPersonalWorkspace } from './workspaces.js';
import { generateBrowserHandle } from '../handle.js';
import { isWellFormedBrowserId } from '../vms.js';

const db = () => getDatabase();

// Capital 'B' for browser, easy to recognize.
const generatePublicId = () => generateShortId('B', 6);

const map = (r) => ({
  browserInstanceId: r.id,
  publicId: r.public_id,
  browserName: r.browser_name,
  browserDescription: r.browser_description,
  status: r.status,
  browserHandle: r.browser_handle,
  internalBrowserId: r.internal_browser_id,
  creatorUserId: r.user_id,
  // Settings applied to the browser, e.g. { proxy }, with secrets already masked.
  config: r.config || {}
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

// Per workspace, for the web UI and the REST API alike. Only a guard against
// bursts, set high enough that normal use never meets it.
const MAX_BROWSER_LAUNCHES_PER_MINUTE = 120;
const LAUNCH_WINDOW_MS = 60 * 1000;

// Refuses a launch over the workspace's rate. Runs after the lock, inside the
// launch's transaction, so the count cannot change under it.
const checkLaunchRate = async (tx, { workspaceId, launchesPerMinute, now }) => {
  const recent = await tx.query(
    'SELECT launched_timestamp FROM browser_launches WHERE workspace_id=$1 AND launched_timestamp > $2 ORDER BY launched_timestamp',
    [workspaceId, now - LAUNCH_WINDOW_MS]
  );
  if (recent.rows.length < launchesPerMinute) {
    return null;
  }
  // A slot frees up when the oldest launch in the window leaves it.
  const freedAt = recent.rows[recent.rows.length - launchesPerMinute].launched_timestamp + LAUNCH_WINDOW_MS;
  return { error: 'LAUNCH_RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil((freedAt - now) / 1000)) };
};

// A refused launch returns LAUNCH_RATE_LIMITED with retryAfterSeconds.
// generateId, launchesPerMinute, and now are injectable only for tests.
const launchBrowserInstance = async ({
  workspaceId,
  userId,
  browserName,
  browserDescription,
  personalWorkspaceRepair,
  config = null,
  generateId = generatePublicId,
  launchesPerMinute = MAX_BROWSER_LAUNCHES_PER_MINUTE,
  now = Date.now()
}) => {
  await ensureWorkspaceForRepair(workspaceId, personalWorkspaceRepair);
  const database = await db();
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
    try {
      return await database.transaction(async (tx) => {
        // Locks the workspace's row, so two launches in it cannot both pass
        // the count below. Launches in other workspaces do not wait.
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        const refused = await checkLaunchRate(tx, { workspaceId, launchesPerMinute, now });
        if (refused) return refused;
        // Issued before the insert so the row always names a valid browser.
        const browserHandle = generateBrowserHandle();
        const r = await tx.query(
          `INSERT INTO browser_instances(workspace_id,browser_name,browser_description,status,user_id,internal_browser_id,browser_handle,config,public_id) VALUES($1,$2,$3,'starting',$4,'',$5,$7::jsonb,$6) RETURNING id, public_id`,
          [
            workspaceId,
            browserName,
            browserDescription || '',
            userId,
            browserHandle,
            generateId(),
            config ? JSON.stringify(config) : null
          ]
        );
        await tx.query('INSERT INTO browser_launches(workspace_id,user_id,launched_timestamp) VALUES($1,$2,$3)', [
          workspaceId,
          userId,
          now
        ]);
        return { data: { browserInstanceId: r.rows[0].id, publicId: r.rows[0].public_id } };
      });
    } catch (e) {
      // The generated public_id is already taken by another browser; draw again.
      if (e.code === '23505' && e.constraint === 'browser_instances_public_id_unique_idx') continue;
      return { error: e.message };
    }
  }
  return { error: 'PUBLIC_ID_NOT_UNIQUE' };
};

// Writes the internal browser id onto the instance row, for the owner only. The
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

// For statuses observed from the browser (monitors, screenshots, launch). A
// suspended browser is unreachable on purpose, so these leave it alone; only
// transitionBrowserInstanceStatus moves a browser in or out of 'suspended'.
const updateBrowserInstanceStatus = async ({ workspaceId, browserInstanceId, toStatus }) => {
  const r = await (
    await db()
  ).query("UPDATE browser_instances SET status=$3 WHERE workspace_id=$1 AND id=$2 AND status <> 'suspended'", [
    workspaceId,
    browserInstanceId,
    toStatus
  ]);
  return { data: r.rowCount > 0 };
};

// Changes the status only from one of `fromStatuses`, so two requests racing
// on the same browser cannot both make the same change.
const transitionBrowserInstanceStatus = async ({ workspaceId, browserInstanceId, fromStatuses, toStatus }) => {
  const r = await (
    await db()
  ).query('UPDATE browser_instances SET status=$3 WHERE workspace_id=$1 AND id=$2 AND status = ANY($4::text[])', [
    workspaceId,
    browserInstanceId,
    toStatus,
    fromStatuses
  ]);
  return { data: r.rowCount > 0 };
};

// Replaces the stored settings, after they were applied to the browser.
const setBrowserInstanceConfig = async ({ workspaceId, browserInstanceId, config }) => {
  const r = await (
    await db()
  ).query('UPDATE browser_instances SET config=$3::jsonb WHERE workspace_id=$1 AND id=$2', [
    workspaceId,
    browserInstanceId,
    JSON.stringify(config)
  ]);
  return { data: r.rowCount > 0 };
};

// Launches older than the window no longer count, so their rows are only
// clutter. Delete them in batches, like expired sign-in codes.
const deleteOldBrowserLaunches = async ({ now = Date.now(), limit = 1000 } = {}) => {
  try {
    const r = await (
      await db()
    ).query(
      'DELETE FROM browser_launches WHERE id IN (SELECT id FROM browser_launches WHERE launched_timestamp <= $1 ORDER BY launched_timestamp LIMIT $2)',
      [now - LAUNCH_WINDOW_MS, limit]
    );
    return { data: r.rowCount };
  } catch (e) {
    return { error: e.message };
  }
};

const deleteBrowserInstance = async ({ workspaceId, browserInstanceId }) => {
  const r = await (
    await db()
  ).query('DELETE FROM browser_instances WHERE workspace_id=$1 AND id=$2', [workspaceId, browserInstanceId]);
  return { data: r.rowCount > 0 };
};

// Every browser that has an internal id, across all workspaces: the monitors to
// restore at startup. Unprovisioned rows have nothing to attach to, and a
// suspended browser gets its monitor back when it is resumed.
const listProvisionedBrowserInstances = async () => {
  const r = await (
    await db()
  ).query(
    "SELECT id, workspace_id, internal_browser_id FROM browser_instances WHERE internal_browser_id <> '' AND status <> 'suspended'"
  );
  return {
    data: r.rows.map((row) => ({
      workspaceId: row.workspace_id,
      browserInstanceId: row.id,
      internalBrowserId: row.internal_browser_id
    }))
  };
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
  MAX_BROWSER_LAUNCHES_PER_MINUTE,
  launchBrowserInstance,
  recordProvisionedBrowser,
  updateBrowserInstanceStatus,
  transitionBrowserInstanceStatus,
  setBrowserInstanceConfig,
  deleteBrowserInstance,
  deleteOldBrowserLaunches,
  listBrowserInstancesByWorkspace,
  listProvisionedBrowserInstances,
  getBrowserInstance,
  getBrowserInstanceByPublicId,
  browserIdForHandle
};
