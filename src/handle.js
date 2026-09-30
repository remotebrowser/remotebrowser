import crypto from 'node:crypto';
import { config } from './config.js';
import { generateShortId, FRIENDLY_CHARS } from './id.js';
import { encodeBase32 } from './base32.js';

// A browser handle is a browser's public name: a random nonce plus a short HMAC.
// The nonce makes it unguessable; the HMAC is only an edge check, so a malformed
// handle can be refused without a database round trip. Keyed by
// RESOURCE_HMAC_SECRET, a separate secret, because this MAC is only an edge
// check - a leaked SESSION_SECRET would have real impact.
//
// Treat a handle as a credential: holding one drives the browser it names, so it
// must never be logged.
//
// The HMAC does NOT stop brute force: it only proves this app issued the
// handle, not that the holder is authorized some other way. Security comes
// from the nonce's 120 bits, so do not shorten the nonce just because the MAC
// is here.

// Handles start with a capital 'H', a cheap marker that makes them easy to
// recognize and cheap to reject anything else without counting characters.
const HANDLE_PREFIX = 'H';

// 24 nonce characters is 120 bits. 12 MAC characters is 60 bits, plenty for a
// check that only rejects junk locally. The prefix rides along for free.
const NONCE_LENGTH = 24;
const MAC_LENGTH = 12;
const BROWSER_HANDLE_LENGTH = HANDLE_PREFIX.length + NONCE_LENGTH + MAC_LENGTH;
// FRIENDLY_CHARS has no regex metacharacters, so it drops into a character class
// as-is. The body is the fixed friendly length; the prefix is matched literally.
const BROWSER_HANDLE_PATTERN = new RegExp(
  `^${HANDLE_PREFIX}[${FRIENDLY_CHARS}]{${BROWSER_HANDLE_LENGTH - HANDLE_PREFIX.length}}$`
);

const macWith = (secret, nonce) =>
  encodeBase32(crypto.createHmac('sha256', secret).update(nonce).digest()).slice(0, MAC_LENGTH);

/**
 * Issues a new handle, signed with RESOURCE_HMAC_SECRET.
 * @returns {string}
 */
const generateBrowserHandle = () => {
  const nonce = generateShortId('', NONCE_LENGTH);
  return HANDLE_PREFIX + nonce + macWith(config.resourceHmacSecret, nonce);
};

/**
 * Whether this app could have issued the handle. It says nothing about whether
 * the handle still resolves to a browser - that is the database lookup's job.
 * There is no secret rotation: once issued, a handle cannot be rotated, so only
 * the current secret is accepted.
 * @param {string} handle
 * @returns {boolean}
 */
const isWellFormedBrowserHandle = (handle) => {
  if (typeof handle !== 'string' || !BROWSER_HANDLE_PATTERN.test(handle)) {
    return false;
  }
  const nonce = handle.slice(HANDLE_PREFIX.length, HANDLE_PREFIX.length + NONCE_LENGTH);
  const given = Buffer.from(handle.slice(HANDLE_PREFIX.length + NONCE_LENGTH));
  const expected = Buffer.from(macWith(config.resourceHmacSecret, nonce));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

export { generateBrowserHandle, isWellFormedBrowserHandle, BROWSER_HANDLE_LENGTH, HANDLE_PREFIX };
