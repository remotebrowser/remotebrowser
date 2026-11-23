import crypto from 'node:crypto';
import { config } from './config.js';
import { generateShortId, FRIENDLY_CHARS } from './id.js';
import { encodeBase32 } from './base32.js';

// Secrets of the CLI login (the OAuth device flow, RFC 8628). Like an API key
// (see src/apikey.js), a token is a random nonce plus a short HMAC, so a wrong
// token is refused without a database lookup. Never log a token or a device
// code. Store only their SHA-256 digests.

// The prefix lets secret scanners find a leaked token.
const CLI_TOKEN_PREFIX = 'rb-cli-v1-';

// 52 characters of 5 bits each: more than 256 bits of nonce.
const NONCE_LENGTH = 52;
const MAC_LENGTH = 12;
const CLI_TOKEN_PATTERN = new RegExp(`^${CLI_TOKEN_PREFIX}[${FRIENDLY_CHARS}]{${NONCE_LENGTH + MAC_LENGTH}}$`);

// Tagged differently from an API key, so one can never be used as the other.
const macWith = (secret, nonce) =>
  encodeBase32(crypto.createHmac('sha256', secret).update(`cli-token.${nonce}`).digest()).slice(0, MAC_LENGTH);

/** @returns {string} */
const generateCliToken = () => {
  const nonce = generateShortId('', NONCE_LENGTH);
  return CLI_TOKEN_PREFIX + nonce + macWith(config.resourceHmacSecret, nonce);
};

const isCliToken = (token) => typeof token === 'string' && token.startsWith(CLI_TOKEN_PREFIX);

/**
 * Checks only that this app could have issued the token. The database lookup
 * checks whether it still works.
 * @param {string} token
 * @returns {boolean}
 */
const isWellFormedCliToken = (token) => {
  if (typeof token !== 'string' || !CLI_TOKEN_PATTERN.test(token)) {
    return false;
  }
  const nonce = token.slice(CLI_TOKEN_PREFIX.length, CLI_TOKEN_PREFIX.length + NONCE_LENGTH);
  const given = Buffer.from(token.slice(CLI_TOKEN_PREFIX.length + NONCE_LENGTH));
  const expected = Buffer.from(macWith(config.resourceHmacSecret, nonce));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

// 32 random bytes, URL-safe. Only the CLI ever sees it.
const generateDeviceCode = () => crypto.randomBytes(32).toString('base64url');

// No vowels and no look-alike characters, so a code cannot spell a word and is
// easy to read aloud and type.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;

// Stored without the dash; shown as XXXX-XXXX.
const generateUserCode = () => {
  let code = '';
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
};

const USER_CODE_PATTERN = new RegExp(`^[${USER_CODE_ALPHABET}]{${USER_CODE_LENGTH}}$`);

/**
 * Accepts a typed code in any case, with or without the dash or spaces.
 * @param {string} input
 * @returns {string | null} the stored form, or null if it cannot be a code
 */
const normalizeUserCode = (input) => {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return USER_CODE_PATTERN.test(code) ? code : null;
};

const formatUserCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

export {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  isCliToken,
  isWellFormedCliToken,
  hashSecret,
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode,
  formatUserCode,
  USER_CODE_ALPHABET
};
