import crypto from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import { consola } from 'consola/basic';
import { config } from '../config.js';
import { cookieName } from './cookies.js';
import { sign, signatureMatches } from './signing.js';

const CSRF_ID_COOKIE = cookieName('csrf_id');

const setCsrfId = (c, id) => {
  setCookie(c, CSRF_ID_COOKIE, id, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    path: '/'
  });
  return id;
};

const newCsrfId = () => crypto.randomBytes(16).toString('hex');

const ensureCsrfId = (c) => {
  const existing = getCookie(c, CSRF_ID_COOKIE);
  if (existing && /^[0-9a-f]{32}$/.test(existing)) {
    return existing;
  }
  if (existing) {
    consola.warn('CSRF id cookie malformed, regenerating');
  }
  return setCsrfId(c, newCsrfId());
};

// Tokens are tied to the id, so rotate it when the user changes.
const rotateCsrfId = (c) => setCsrfId(c, newCsrfId());

const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;

const tokenForId = (csrfId) => {
  const expires = Date.now() + CSRF_TOKEN_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

const createCsrfToken = (c) => tokenForId(ensureCsrfId(c));

// getCookie can't see a Set-Cookie from this same request, so mint the token from the rotated id directly.
const rotateCsrfToken = (c) => tokenForId(rotateCsrfId(c));

const verifyCsrfToken = (c, token) => {
  const csrfId = getCookie(c, CSRF_ID_COOKIE);
  if (!csrfId || !/^[0-9a-f]{32}$/.test(csrfId) || typeof token !== 'string') {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }
  const [expires, signature] = parts;
  if (!signatureMatches(`csrf.${csrfId}.${expires}`, signature)) {
    return false;
  }
  return /^\d+$/.test(expires) && Number(expires) >= Date.now();
};

export { ensureCsrfId, rotateCsrfId, createCsrfToken, rotateCsrfToken, verifyCsrfToken };
