import { config } from './config.js';

// This becomes the continueUrl of every sign-in and invite link, so it must not
// come from the request: c.req.url is built from the client-supplied Host
// header, and a forged one would send a real sign-in link (nonce included) to
// an attacker. Production pins it to PUBLIC_ORIGIN; development has no fixed
// hostname, so it falls back to the request.
const absoluteOrigin = (c) => {
  if (config.publicOrigin) {
    return config.publicOrigin;
  }
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
};

export { absoluteOrigin };
