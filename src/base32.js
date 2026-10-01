import { FRIENDLY_CHARS } from './id.js';

// FRIENDLY_CHARS is exactly 32 characters, so this is base32 at 5 bits each.
// src/handle.js uses it to render an HMAC digest in the same alphabet as the
// nonce, so a handle is one friendly-charset string end to end.
const encodeBase32 = (bytes) => {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += FRIENDLY_CHARS[(value >>> bits) & 31];
    }
  }
  return out;
};

export { encodeBase32 };
