import { getDatabase } from '../db/database.js';
import { generateShortId } from '../id.js';
import { generateCliToken, generateDeviceCode, generateUserCode, hashSecret } from '../cli.js';

const db = () => getDatabase();

// Starts with 'C', so a CLI session id is easy to recognize.
const generatePublicId = () => generateShortId('C', 10);

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// Fixed for now; using the token does not extend it.
const CLI_SESSION_DAYS = 30;
const CLI_SESSION_MS = CLI_SESSION_DAYS * DAY_MS;

// How long the user has to approve a login (RFC 8628 suggests 10-15 minutes).
const DEVICE_CODE_TTL_MS = 15 * MINUTE_MS;

// The polling interval the CLI is told to use, in seconds.
const POLL_INTERVAL_SECONDS = 5;

// Network delays can bring two polls a bit closer than the interval.
const POLL_TOLERANCE_MS = 1000;

// An expired token is kept this long, so its owner sees "Your login has
// expired." rather than a plain 401.
const EXPIRED_SESSION_GRACE_MS = 30 * DAY_MS;

// Collisions are rare (32^6 public ids, 20^8 user codes), so a few redraws are plenty.
const MAX_ATTEMPTS = 5;

// The CLI describes itself, so the values are not trusted. They are cut short,
// so a long value cannot fill a page.
const clip = (value, max) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
};

const mapSession = (r) => ({
  cliSessionId: r.id,
  publicId: r.public_id,
  workspaceId: r.workspace_id,
  name: r.name,
  creatorUserId: r.user_id,
  deviceName: r.device_name,
  ipAddress: r.ip_address,
  userAgent: r.user_agent,
  createdTimestamp: r.created_timestamp,
  expiresTimestamp: r.expires_timestamp,
  // Null until the token is first used.
  lastUsedTimestamp: r.last_used_timestamp,
  // Set only when the query joins users.
  creatorEmail: r.creator_email
});

const mapAuthorization = (r) => ({
  deviceAuthorizationId: r.id,
  userCode: r.user_code,
  status: r.status,
  deviceName: r.device_name,
  ipAddress: r.ip_address,
  userAgent: r.user_agent,
  createdTimestamp: r.created_timestamp,
  expiresTimestamp: r.expires_timestamp
});

// Starting a login needs no sign-in, so anyone can fill the table. A real user
// starts a login a few times at most. The window must stay shorter than
// DEVICE_CODE_TTL_MS: clean-up deletes expired rows, and the counts need them.
const START_WINDOW_MS = 10 * MINUTE_MS;
// Per client address. Roomy enough for a shared office address (NAT).
const MAX_STARTS_PER_IP = 10;
// All addresses together. A botnet can still use this up and block new logins
// for a while, but the table stays small and existing logins keep working.
const MAX_STARTS_TOTAL = 300;

// A slot frees up when the oldest start in the window leaves it.
const retryAfterFor = (timestamps, limit, now) => {
  const freedAt = Number(timestamps[timestamps.length - limit]) + START_WINDOW_MS;
  return Math.max(1, Math.ceil((freedAt - now) / 1000));
};

// Runs inside the insert's transaction, after its lock, so concurrent starts
// cannot all pass on the same count.
const checkStartRate = async (tx, { ipAddress, maxPerIp, maxTotal, now }) => {
  const since = now - START_WINDOW_MS;
  const all = await tx.query(
    'SELECT created_timestamp FROM device_authorizations WHERE created_timestamp > $1 ORDER BY created_timestamp',
    [since]
  );
  const mine = await tx.query(
    `SELECT created_timestamp FROM device_authorizations
     WHERE created_timestamp > $1 AND ip_address IS NOT DISTINCT FROM $2 ORDER BY created_timestamp`,
    [since, ipAddress]
  );
  const waits = [];
  if (mine.rows.length >= maxPerIp)
    waits.push(
      retryAfterFor(
        mine.rows.map((r) => r.created_timestamp),
        maxPerIp,
        now
      )
    );
  if (all.rows.length >= maxTotal)
    waits.push(
      retryAfterFor(
        all.rows.map((r) => r.created_timestamp),
        maxTotal,
        now
      )
    );
  return waits.length ? { error: 'DEVICE_RATE_LIMITED', retryAfterSeconds: Math.max(...waits) } : null;
};

// An arbitrary number, shared by all server instances.
const START_LOCK_ID = 4_201_401;

/**
 * Starts a login. Returns the device code once; only its digest is stored.
 * A refused start returns error DEVICE_RATE_LIMITED with retryAfterSeconds.
 * The limits and now are injectable only for tests.
 */
const createDeviceAuthorization = async ({
  deviceName,
  ipAddress,
  userAgent,
  maxPerIp = MAX_STARTS_PER_IP,
  maxTotal = MAX_STARTS_TOTAL,
  now = Date.now()
}) => {
  const database = await db();
  // The stored form, so the per-address count compares like with like.
  const address = clip(ipAddress, 64);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    try {
      return await database.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [START_LOCK_ID]);
        const refusal = await checkStartRate(tx, { ipAddress: address, maxPerIp, maxTotal, now });
        if (refusal) return refusal;
        const r = await tx.query(
          `INSERT INTO device_authorizations(device_code_hash,user_code,device_name,ip_address,user_agent,created_timestamp,expires_timestamp)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            hashSecret(deviceCode),
            userCode,
            clip(deviceName, 64),
            address,
            clip(userAgent, 200),
            now,
            now + DEVICE_CODE_TTL_MS
          ]
        );
        return { data: { ...mapAuthorization(r.rows[0]), deviceCode } };
      });
    } catch (e) {
      // Another pending login has this user code; draw again.
      if (e.code === '23505') continue;
      return { error: e.message };
    }
  }
  return { error: 'USER_CODE_NOT_UNIQUE' };
};

// A login the user may still approve or deny.
const findPendingDeviceAuthorization = async ({ userCode, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(`SELECT * FROM device_authorizations WHERE user_code=$1 AND status='pending' AND expires_timestamp > $2`, [
      userCode,
      now
    ]);
    return { data: r.rows[0] ? mapAuthorization(r.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

// Only a pending login is updated, so a second submit cannot approve twice or
// turn a denial into an approval. data is false when the login is gone or
// already decided.
const decideDeviceAuthorization = async ({ userCode, approve, userId, workspaceId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(
      `UPDATE device_authorizations SET status=$2, user_id=$3, workspace_id=$4, approved_timestamp=$5
       WHERE user_code=$1 AND status='pending' AND expires_timestamp > $5`,
      [userCode, approve ? 'approved' : 'denied', approve ? userId : null, approve ? workspaceId : null, now]
    );
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

/**
 * One poll of the CLI. data.status is 'pending', 'slow_down', 'denied',
 * 'expired', or 'issued' (with the token, returned only this once).
 */
const pollDeviceAuthorization = async ({ deviceCode, now = Date.now(), generateId = generatePublicId }) => {
  if (typeof deviceCode !== 'string' || !deviceCode) return { data: { status: 'expired' } };
  const database = await db();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const token = generateCliToken();
    try {
      return await database.transaction(async (tx) => {
        // Locked, so two polls at once cannot both take the token.
        const found = await tx.query('SELECT * FROM device_authorizations WHERE device_code_hash=$1 FOR UPDATE', [
          hashSecret(deviceCode)
        ]);
        const row = found.rows[0];
        if (!row || row.status === 'used' || Number(row.expires_timestamp) <= now) {
          return { data: { status: 'expired' } };
        }
        const lastPolled = row.last_polled_timestamp === null ? null : Number(row.last_polled_timestamp);
        await tx.query('UPDATE device_authorizations SET last_polled_timestamp=$2 WHERE id=$1', [row.id, now]);
        if (lastPolled !== null && now - lastPolled < POLL_INTERVAL_SECONDS * 1000 - POLL_TOLERANCE_MS) {
          return { data: { status: 'slow_down' } };
        }
        if (row.status === 'pending') return { data: { status: 'pending' } };
        if (row.status === 'denied') return { data: { status: 'denied' } };
        const deviceName = row.device_name;
        const inserted = await tx.query(
          `INSERT INTO cli_sessions(public_id,workspace_id,user_id,name,token_hash,device_name,ip_address,user_agent,created_timestamp,expires_timestamp)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            generateId(),
            row.workspace_id,
            row.user_id,
            deviceName ? `CLI on ${deviceName}` : 'CLI',
            hashSecret(token),
            deviceName,
            row.ip_address,
            row.user_agent,
            now,
            now + CLI_SESSION_MS
          ]
        );
        await tx.query(`UPDATE device_authorizations SET status='used' WHERE id=$1`, [row.id]);
        return {
          data: {
            status: 'issued',
            token,
            expiresIn: Math.round(CLI_SESSION_MS / 1000),
            session: mapSession(inserted.rows[0])
          }
        };
      });
    } catch (e) {
      // The generated public_id is already taken; draw again.
      if (e.code === '23505' && e.constraint === 'cli_sessions_public_id_unique_idx') continue;
      return { error: e.message };
    }
  }
  return { error: 'PUBLIC_ID_NOT_UNIQUE' };
};

// Like API keys, a session acts for its creator, so a user sees only their own.
const listCliSessionsByUser = async ({ workspaceId, userId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(
      'SELECT * FROM cli_sessions WHERE workspace_id=$1 AND user_id=$2 AND expires_timestamp > $3 ORDER BY id DESC',
      [workspaceId, userId, now]
    );
    return { data: r.rows.map(mapSession) };
  } catch (e) {
    return { error: e.message };
  }
};

// Every member's active sessions, for the workspace's Admins.
const listCliSessionsByWorkspace = async ({ workspaceId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(
      `SELECT s.*, u.email AS creator_email FROM cli_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.workspace_id=$1 AND s.expires_timestamp > $2 ORDER BY s.id DESC`,
      [workspaceId, now]
    );
    return { data: r.rows.map(mapSession) };
  } catch (e) {
    return { error: e.message };
  }
};

// The route decides who may see it, as for API keys.
const getCliSessionByPublicId = async ({ workspaceId, publicId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(
      `SELECT s.*, u.email AS creator_email FROM cli_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.workspace_id=$1 AND s.public_id=$2 AND s.expires_timestamp > $3`,
      [workspaceId, publicId, now]
    );
    return { data: r.rows[0] ? mapSession(r.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

// Takes effect at once: the next call with the token finds nothing.
const deleteCliSession = async ({ workspaceId, publicId }) => {
  try {
    const r = await (
      await db()
    ).query('DELETE FROM cli_sessions WHERE workspace_id=$1 AND public_id=$2', [workspaceId, publicId]);
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

// For 'remotebrowser logout': the token revokes itself.
const deleteCliSessionByToken = async ({ token }) => {
  try {
    const r = await (await db()).query('DELETE FROM cli_sessions WHERE token_hash=$1', [hashSecret(token)]);
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

// Expired sessions are returned too, so the caller can say why a token fails.
const findCliSessionByToken = async ({ token }) => {
  try {
    const r = await (await db()).query('SELECT * FROM cli_sessions WHERE token_hash=$1', [hashSecret(token)]);
    return { data: r.rows[0] ? mapSession(r.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

// Written at most once a minute per session, as for API keys.
const LAST_USED_INTERVAL = 60 * 1000;

const recordCliSessionUse = async ({ cliSessionId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(
      `UPDATE cli_sessions SET last_used_timestamp=$2
       WHERE id=$1 AND (last_used_timestamp IS NULL OR last_used_timestamp <= $3)`,
      [cliSessionId, now, now - LAST_USED_INTERVAL]
    );
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

// In batches, like expired API keys, so one run does not hold the tables long.
const cleanupCliSessions = async ({ now = Date.now(), limit = 100 } = {}) => {
  try {
    const database = await db();
    const sessions = await database.query(
      'DELETE FROM cli_sessions WHERE id IN (SELECT id FROM cli_sessions WHERE expires_timestamp <= $1 ORDER BY expires_timestamp LIMIT $2)',
      [now - EXPIRED_SESSION_GRACE_MS, limit]
    );
    const authorizations = await database.query(
      'DELETE FROM device_authorizations WHERE id IN (SELECT id FROM device_authorizations WHERE expires_timestamp <= $1 ORDER BY expires_timestamp LIMIT $2)',
      [now, limit]
    );
    return { data: sessions.rowCount + authorizations.rowCount };
  } catch (e) {
    return { error: e.message };
  }
};

export {
  CLI_SESSION_DAYS,
  START_WINDOW_MS,
  MAX_STARTS_PER_IP,
  DEVICE_CODE_TTL_MS,
  POLL_INTERVAL_SECONDS,
  createDeviceAuthorization,
  findPendingDeviceAuthorization,
  decideDeviceAuthorization,
  pollDeviceAuthorization,
  listCliSessionsByUser,
  listCliSessionsByWorkspace,
  getCliSessionByPublicId,
  deleteCliSession,
  deleteCliSessionByToken,
  findCliSessionByToken,
  recordCliSessionUse,
  cleanupCliSessions
};
