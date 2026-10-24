import crypto from 'node:crypto';
import { config } from './config.js';
import { generateShortId, FRIENDLY_CHARS } from './id.js';
import { encodeBase32 } from './base32.js';

// Built like a browser handle (see src/handle.js): a random nonce plus a short
// HMAC keyed by RESOURCE_HMAC_SECRET. The nonce is the secret part; the HMAC only
// rejects junk before a database lookup.
//
// The HMAC input is tagged, so a handle cannot pass as a key, or a key as a handle.
//
// A key is a credential: never log it, and store only its SHA-256 digest.

// Versioned, so a later key format can be told apart from this one.
const API_KEY_PREFIX = 'sk-rb-v1-';

// Same sizes as a browser handle: 120 bits of nonce, 60 bits of MAC.
const NONCE_LENGTH = 24;
const MAC_LENGTH = 12;
const API_KEY_LENGTH = API_KEY_PREFIX.length + NONCE_LENGTH + MAC_LENGTH;
// FRIENDLY_CHARS has no regex metacharacters, and neither does the prefix.
const API_KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[${FRIENDLY_CHARS}]{${NONCE_LENGTH + MAC_LENGTH}}$`);

const macWith = (secret, nonce) =>
  encodeBase32(crypto.createHmac('sha256', secret).update(`api-key.${nonce}`).digest()).slice(0, MAC_LENGTH);

/**
 * Issues a new API key, signed with RESOURCE_HMAC_SECRET.
 * @returns {string}
 */
const generateApiKey = () => {
  const nonce = generateShortId('', NONCE_LENGTH);
  return API_KEY_PREFIX + nonce + macWith(config.resourceHmacSecret, nonce);
};

/**
 * Whether this app could have issued the key. It says nothing about whether
 * the key exists or has expired - that is the database lookup's job.
 * @param {string} key
 * @returns {boolean}
 */
const isWellFormedApiKey = (key) => {
  if (typeof key !== 'string' || !API_KEY_PATTERN.test(key)) {
    return false;
  }
  const nonce = key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + NONCE_LENGTH);
  const given = Buffer.from(key.slice(API_KEY_PREFIX.length + NONCE_LENGTH));
  const expected = Buffer.from(macWith(config.resourceHmacSecret, nonce));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

const hashApiKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// Enough to recognize a key in a list, far too little to guess the rest.
const PREVIEW_LENGTH = 4;
const previewApiKey = (key) => `${key.slice(0, API_KEY_PREFIX.length + PREVIEW_LENGTH)}…`;

export { generateApiKey, isWellFormedApiKey, hashApiKey, previewApiKey, API_KEY_LENGTH, API_KEY_PREFIX };
