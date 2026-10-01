import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.js';
import { cookieName } from './cookies.js';
import { sign, signatureMatches } from './signing.js';

// Only this module knows the cookie names, so the __Host- prefix rule is applied consistently.
const SESSION_COOKIE = cookieName('session');
const SIGNIN_EMAIL_COOKIE = cookieName('signin_email');

// Tokens are encrypted with an AES key derived separately from HMAC secret so leaked cookies stay confidential.
const CIPHER_ALGO = 'aes-256-gcm';
const deriveCipherKeys = (label) =>
  [config.sessionSecret, config.previousSessionSecret]
    .filter(Boolean)
    .map((secret) => crypto.createHmac('sha256', secret).update(label).digest());

const encryptValue = (plaintext, key) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, ciphertext, authTag].map((buf) => buf.toString('base64url')).join('.');
};

const decryptValue = (token, keys) => {
  if (typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  let iv, ciphertext, authTag;
  try {
    [iv, ciphertext, authTag] = parts.map((part) => Buffer.from(part, 'base64url'));
  } catch {
    return null;
  }
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      continue;
    }
  }
  return null;
};

const sessionCipherKeys = deriveCipherKeys('session-cookie-encryption');

// The remembered email must not outlive the sign-in flow, so it expires on its own.
const SIGNIN_EMAIL_TTL_MS = 30 * 60 * 1000;

const createSessionCookie = (session) => encryptValue(JSON.stringify(session), sessionCipherKeys[0]);

const sessionAgeMs = (session) => Date.now() - session.issuedAt;

const sessionRemainingSeconds = (session) =>
  Math.max(0, Math.ceil((config.sessionTtlSeconds * 1000 - sessionAgeMs(session)) / 1000));

const readSessionCookie = (token) => {
  const plaintext = decryptValue(token, sessionCipherKeys);
  if (plaintext === null) {
    return null;
  }
  let session;
  try {
    session = JSON.parse(plaintext);
  } catch {
    return null;
  }
  // The cookie carries the public id only; the numeric key stays server-side.
  if (typeof session.publicId !== 'string' || typeof session.email !== 'string') {
    return null;
  }
  if (typeof session.issuedAt !== 'number' || session.issuedAt < config.sessionNotBefore) {
    return null;
  }
  // The cookie's maxAge is only a hint, and the refresh token never expires on
  // its own. Without this check a captured cookie stays usable forever, so the
  // TTL must be enforced on every read.
  if (sessionAgeMs(session) > config.sessionTtlSeconds * 1000) {
    return null;
  }
  // The active workspace rides along with the credential but is not part of it:
  // an older cookie without it is still a good session, and a malformed value
  // must not cost anyone their sign-in.
  if (!Number.isSafeInteger(session.activeWorkspaceId)) {
    delete session.activeWorkspaceId;
  }
  return session;
};

const readSessionCookieFrom = (c) => readSessionCookie(getCookie(c, SESSION_COOKIE));

const setSessionCookie = (c, session) => {
  setCookie(c, SESSION_COOKIE, createSessionCookie(session), {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    path: '/',
    // Derived from issuedAt so token refreshes don't slide the cookie expiry forward.
    maxAge: sessionRemainingSeconds(session)
  });
};

const clearSessionCookie = (c) => deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.secureCookies });

// The read-modify-write lives here, next to the only code that knows the
// payload's shape, so switching workspaces cannot drop a field the caller did
// not know about. Returns false when there is no session to amend.
const setActiveWorkspace = (c, workspaceId) => {
  const session = readSessionCookieFrom(c);
  if (!session) {
    return false;
  }
  if (workspaceId) {
    session.activeWorkspaceId = workspaceId;
  } else {
    delete session.activeWorkspaceId;
  }
  setSessionCookie(c, session);
  return true;
};

const createSigninEmailCookie = (c, email) => {
  const expires = Date.now() + SIGNIN_EMAIL_TTL_MS;
  const emailB64 = Buffer.from(email).toString('base64url');
  const signature = sign(`signinemail.${expires}.${emailB64}`);
  setCookie(c, SIGNIN_EMAIL_COOKIE, `${expires}.${emailB64}.${signature}`, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    path: '/'
  });
};

const readSigninEmailCookie = (c) => {
  const token = getCookie(c, SIGNIN_EMAIL_COOKIE);
  if (typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [expires, emailB64, signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) <= Date.now()) {
    return null;
  }
  if (!signatureMatches(`signinemail.${expires}.${emailB64}`, signature)) {
    return null;
  }
  try {
    return Buffer.from(emailB64, 'base64url').toString();
  } catch {
    return null;
  }
};

const clearSigninEmailCookie = (c) => deleteCookie(c, SIGNIN_EMAIL_COOKIE, { path: '/', secure: config.secureCookies });

export {
  createSessionCookie,
  readSessionCookie,
  readSessionCookieFrom,
  sessionRemainingSeconds,
  setSessionCookie,
  setActiveWorkspace,
  clearSessionCookie,
  createSigninEmailCookie,
  readSigninEmailCookie,
  clearSigninEmailCookie
};
