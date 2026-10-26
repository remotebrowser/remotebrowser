import { getDatabase } from '../db/database.js';
import { generateShortId } from '../id.js';
import { generateApiKey, hashApiKey, previewApiKey } from '../apikey.js';

const db = () => getDatabase();

// Capital 'K' for key, easy to recognize.
const generatePublicId = () => generateShortId('K', 6);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The only lifetimes on offer; anything else is refused before the insert.
const API_KEY_EXPIRATIONS = [
  { value: '1h', label: '1 hour', ms: HOUR_MS },
  { value: '1d', label: '1 day', ms: DAY_MS },
  { value: '7d', label: '7 days', ms: 7 * DAY_MS },
  { value: '30d', label: '30 days', ms: 30 * DAY_MS },
  { value: '90d', label: '90 days', ms: 90 * DAY_MS }
];

const expirationFor = (value) => API_KEY_EXPIRATIONS.find((expiration) => expiration.value === value) || null;

const map = (r) => ({
  apiKeyId: r.id,
  publicId: r.public_id,
  workspaceId: r.workspace_id,
  name: r.name,
  keyPreview: r.key_preview,
  creatorUserId: r.user_id,
  createdTimestamp: r.created_timestamp,
  expiresTimestamp: r.expires_timestamp,
  // Null until the key is first used.
  lastUsedTimestamp: r.last_used_timestamp,
  // Only where the query joins users.
  creatorEmail: r.creator_email
});

// A collision is vanishingly rare (32^6), so a handful of redraws is plenty.
const MAX_PUBLIC_ID_ATTEMPTS = 5;

// The most valid keys one person may hold: in their personal workspace, and in
// each shared workspace they belong to.
const MAX_PERSONAL_API_KEYS = 10;
const MAX_SHARED_API_KEYS_PER_MEMBER = 5;

// Returns the plain key once; only its digest is stored, so it can never be
// shown again. With maxKeys, refuses with TOO_MANY_API_KEYS. generateId and now
// are injectable only for tests.
const createApiKey = async ({
  workspaceId,
  userId,
  name,
  expiration,
  maxKeys = null,
  generateId = generatePublicId,
  now = Date.now()
}) => {
  const lifetime = expirationFor(expiration);
  if (!lifetime) return { error: 'INVALID_EXPIRATION' };
  const database = await db();
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
    const apiKey = generateApiKey();
    try {
      return await database.transaction(async (tx) => {
        if (maxKeys !== null) {
          // Locks the workspace's row, so two requests cannot both pass the count.
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
          const valid = await tx.query(
            'SELECT count(*) AS count FROM api_keys WHERE workspace_id=$1 AND user_id=$2 AND expires_timestamp > $3',
            [workspaceId, userId, now]
          );
          if (Number(valid.rows[0].count) >= maxKeys) return { error: 'TOO_MANY_API_KEYS' };
        }
        const r = await tx.query(
          `INSERT INTO api_keys(public_id,workspace_id,user_id,name,key_hash,key_preview,created_timestamp,expires_timestamp)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [generateId(), workspaceId, userId, name, hashApiKey(apiKey), previewApiKey(apiKey), now, now + lifetime.ms]
        );
        return { data: { ...map(r.rows[0]), apiKey } };
      });
    } catch (e) {
      // The generated public_id is already taken by another key; draw again.
      if (e.code === '23505' && e.constraint === 'api_keys_public_id_unique_idx') continue;
      return { error: e.message };
    }
  }
  return { error: 'PUBLIC_ID_NOT_UNIQUE' };
};

// A key acts for its creator, so a user sees only their own keys, and only the
// ones that still work. A null limit lists them all.
const listApiKeysByUser = async ({ workspaceId, userId, limit = null, now = Date.now() }) => {
  const r = await (
    await db()
  ).query(
    'SELECT * FROM api_keys WHERE workspace_id=$1 AND user_id=$2 AND expires_timestamp > $3 ORDER BY id DESC LIMIT $4',
    [workspaceId, userId, now, limit]
  );
  return { data: r.rows.map(map) };
};

// Valid keys only: an expired key no longer counts.
const countApiKeysByUser = async ({ workspaceId, userId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query('SELECT count(*) AS count FROM api_keys WHERE workspace_id=$1 AND user_id=$2 AND expires_timestamp > $3', [
      workspaceId,
      userId,
      now
    ]);
    return { data: Number(r.rows[0].count) };
  } catch (e) {
    return { error: e.message };
  }
};

// Every member's valid keys, with who created each, for the workspace's Admins.
const listApiKeysByWorkspace = async ({ workspaceId, limit = null, now = Date.now() }) => {
  const r = await (
    await db()
  ).query(
    `SELECT k.*, u.email AS creator_email FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.workspace_id=$1 AND k.expires_timestamp > $2 ORDER BY k.id DESC LIMIT $3`,
    [workspaceId, now, limit]
  );
  return { data: r.rows.map(map) };
};

// A valid key of the workspace, whoever created it. Who may see it is the
// route's call (canManageApiKey), as for browsers.
const getApiKeyByPublicId = async ({ workspaceId, publicId, now = Date.now() }) => {
  const r = await (
    await db()
  ).query(
    `SELECT k.*, u.email AS creator_email FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.workspace_id=$1 AND k.public_id=$2 AND k.expires_timestamp > $3`,
    [workspaceId, publicId, now]
  );
  return { data: r.rows[0] ? map(r.rows[0]) : null };
};

// Takes effect at once: the next call with the key finds nothing.
const deleteApiKey = async ({ workspaceId, publicId }) => {
  const r = await (
    await db()
  ).query('DELETE FROM api_keys WHERE workspace_id=$1 AND public_id=$2', [workspaceId, publicId]);
  return { data: r.rowCount > 0 };
};

// Written at most this often per key, so a busy key does not cost a write per call.
const LAST_USED_INTERVAL = 60 * 1000;

// The check is in the WHERE clause, so it holds across server processes with no
// state kept in memory.
const recordApiKeyUse = async ({ apiKeyId, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query(
      `UPDATE api_keys SET last_used_timestamp=$2
       WHERE id=$1 AND (last_used_timestamp IS NULL OR last_used_timestamp <= $3)`,
      [apiKeyId, now, now - LAST_USED_INTERVAL]
    );
    return { data: r.rowCount > 0 };
  } catch (e) {
    return { error: e.message };
  }
};

// An expired key can never be used again, so its row is only clutter. Delete it
// in batches, like expired sign-in codes, so one run does not hold the table long.
const cleanupApiKeys = async ({ now = Date.now(), limit = 100 } = {}) => {
  try {
    const r = await (
      await db()
    ).query(
      'DELETE FROM api_keys WHERE id IN (SELECT id FROM api_keys WHERE expires_timestamp <= $1 ORDER BY expires_timestamp LIMIT $2)',
      [now, limit]
    );
    return { data: r.rowCount };
  } catch (e) {
    return { error: e.message };
  }
};

// Looked up by digest, like a sign-in code. An expired key is the same as no key.
const findActiveApiKey = async ({ apiKey, now = Date.now() }) => {
  try {
    const r = await (
      await db()
    ).query('SELECT * FROM api_keys WHERE key_hash=$1 AND expires_timestamp > $2', [hashApiKey(apiKey), now]);
    return { data: r.rows[0] ? map(r.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

export {
  API_KEY_EXPIRATIONS,
  MAX_PERSONAL_API_KEYS,
  MAX_SHARED_API_KEYS_PER_MEMBER,
  createApiKey,
  listApiKeysByUser,
  countApiKeysByUser,
  listApiKeysByWorkspace,
  getApiKeyByPublicId,
  deleteApiKey,
  findActiveApiKey,
  recordApiKeyUse,
  cleanupApiKeys
};
