import crypto from 'node:crypto';
import { config } from '../config.js';

const signWith = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

const sign = (value) => signWith(config.sessionSecret, value);

const signatureMatches = (payload, signature) => {
  const given = Buffer.from(signature);
  return [config.sessionSecret, config.previousSessionSecret].filter(Boolean).some((secret) => {
    const expected = signWith(secret, payload);
    return given.length === Buffer.byteLength(expected) && crypto.timingSafeEqual(given, Buffer.from(expected));
  });
};

export { signWith, sign, signatureMatches };
