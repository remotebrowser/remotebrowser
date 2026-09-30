import crypto from 'node:crypto';
import { getDatabase } from '../db/database.js';
import { generateShortId } from '../id.js';

const db = () => getDatabase();

// Capital 'U' for User, easy to recognize.
const generatePublicId = () => generateShortId('U', 6);

const mapUser = (row) => ({
  id: row.id,
  email: row.email,
  publicId: row.public_id,
  sessionExpirationTimestamp: Number(row.session_expiration_timestamp),
  personalWorkspaceId: row.personal_workspace_id
});

const getUser = async ({ id }) => {
  try {
    const result = await (
      await db()
    ).query('SELECT id, email, public_id, session_expiration_timestamp, personal_workspace_id FROM users WHERE id=$1', [
      id
    ]);
    return { data: result.rows[0] ? mapUser(result.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

// The public id is what the session and URLs carry, so resolving it back to the
// numeric key happens here, at the edge of the model.
const getUserByPublicId = async ({ publicId }) => {
  try {
    const result = await (
      await db()
    ).query(
      'SELECT id, email, public_id, session_expiration_timestamp, personal_workspace_id FROM users WHERE public_id=$1',
      [publicId]
    );
    return { data: result.rows[0] ? mapUser(result.rows[0]) : null };
  } catch (e) {
    return { error: e.message };
  }
};

// A collision is vanishingly rare (32^6), so a handful of redraws is plenty.
const MAX_PUBLIC_ID_ATTEMPTS = 5;

// Magic-link sign-in resolves identity by email: reuse the existing user row,
// or mint a fresh one for a brand-new account. One upsert is atomic, so a
// double submit cannot create two accounts for the same address.
// generateId is injectable only so tests can force a public_id collision.
const findOrCreateUser = async ({ email, generateId = generatePublicId }) => {
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
    try {
      const result = await (
        await db()
      ).query(
        `INSERT INTO users (email, session_expiration_timestamp, public_id)
         VALUES ($1, 0, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, public_id, (xmax = 0) AS is_new_user`,
        [email, generateId()]
      );
      const row = result.rows[0];
      // xmax stays 0 only on the inserted path; the upsert's update sets it.
      return { data: { id: row.id, publicId: row.public_id, isNewUser: row.is_new_user } };
    } catch (e) {
      // The generated public_id is already taken by another user; draw again.
      if (e.code === '23505' && e.constraint === 'users_public_id_unique_idx') continue;
      return { error: e.message };
    }
  }
  return { error: 'PUBLIC_ID_NOT_UNIQUE' };
};

const revokeSessions = async ({ id, expirationTimestamp = Date.now() }) => {
  const result = await (
    await db()
  ).query('UPDATE users SET session_expiration_timestamp=$2 WHERE id=$1', [id, expirationTimestamp]);
  return { data: result.rowCount > 0 };
};

// Write-once: only sets the pointer while it is still empty, so a workspace
// can't be swapped out from under a user once claimed.
const setPersonalWorkspaceId = async ({ id, workspaceId }) => {
  const result = await (
    await db()
  ).query('UPDATE users SET personal_workspace_id=$2 WHERE id=$1 AND personal_workspace_id IS NULL', [id, workspaceId]);
  if (result.rowCount === 0) return { error: 'ALREADY_SET' };
  return { data: true };
};

// The code travels through a URL, so only a digest of it is stored; a DB read
// cannot replay a code it has not seen.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const recordSigninCode = async ({ token, email, expires }) => {
  try {
    await (
      await db()
    ).query('INSERT INTO signin_codes (code_hash, email, expires_timestamp) VALUES ($1, $2, $3)', [
      hashToken(token),
      email,
      expires
    ]);
    return { data: true };
  } catch (e) {
    return { error: e.message };
  }
};

// Single-use: consuming deletes the row atomically, so a replayed code cannot
// sign in twice. Returns the stored email only when a matching, unconsumed
// code exists.
const consumeSigninCode = async ({ token, email }) => {
  try {
    const result = await (
      await db()
    ).query('DELETE FROM signin_codes WHERE code_hash=$1 AND email=$2 RETURNING email', [hashToken(token), email]);
    return result.rows.length > 0 ? { data: { email: result.rows[0].email } } : { error: 'INVALID_CODE' };
  } catch (e) {
    return { error: e.message };
  }
};

export {
  getUser,
  getUserByPublicId,
  findOrCreateUser,
  revokeSessions,
  setPersonalWorkspaceId,
  recordSigninCode,
  consumeSigninCode
};
