import crypto from 'node:crypto';
import { config } from '../config.js';

// A sign-in nonce lives for a few minutes; the expiry is folded into it and
// signed, so an expired or tampered nonce is rejected without a database
// round trip. The secret is derived from SESSION_SECRET so no new env var is
// needed.
const NONCE_TTL_MS = 5 * 60 * 1000;

const nonceSecret = crypto.createHmac('sha256', config.sessionSecret).update('signin-nonce').digest();

const signNonce = (value) => crypto.createHmac('sha256', nonceSecret).update(value).digest('base64url');

const nonceMatches = (payload, signature) => {
  const given = Buffer.from(signature);
  const expected = Buffer.from(signNonce(payload));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

const payload = (token, expires, email) => `nonce.${token}.${expires}.${email}`;

// Returns { token, expires, nonce } where `nonce` is the URL-safe string the
// sign-in link carries.
const createNonce = (email) => {
  const token = crypto.randomBytes(16).toString('base64url');
  const expires = Date.now() + NONCE_TTL_MS;
  return { token, expires, nonce: `${token}.${expires}.${signNonce(payload(token, expires, email))}` };
};

// Returns { token, expires } for a nonce that is well-formed, unexpired, and
// signed for the given email; null otherwise. No database access.
const parseNonce = (email, nonce) => {
  if (typeof nonce !== 'string') return null;
  const parts = nonce.split('.');
  if (parts.length !== 3) return null;
  const [token, expires, signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) <= Date.now()) return null;
  if (!nonceMatches(payload(token, expires, email), signature)) return null;
  return { token, expires: Number(expires) };
};

export { NONCE_TTL_MS, createNonce, parseNonce };
