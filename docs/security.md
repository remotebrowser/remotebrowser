# Security

Three important security settings come from environment variables: `SESSION_SECRET`, `RESOURCE_HMAC_SECRET`, and `SECURE_COOKIES`.

## Session secret

**Recommendation:** Generate one with `openssl rand -hex 32`.

`SESSION_SECRET` can be:

- A single string (at least 32 hex characters), or
- A comma-separated list of strings (each at least 32 hex characters)

A single string encrypts and decrypts auth data that travels between the server and the browser (usually in cookies).

A list of strings helps you rotate the secret. The first string is the main secret for encrypting and decrypting. The second string is used only to decrypt old data. If the app decrypts data with the second string, it re-encrypts the session cookie with the first string on the next request that writes it. This way, users do not need to sign in again after you change the secret.

## Resource secret

**Recommendation:** Generate one with `openssl rand -hex 32`.

`RESOURCE_HMAC_SECRET` is a single string (at least 32 hex characters). It is required in production, and the app will not start without it.

This secret signs browser handles. A handle is the public name that drives a browser. It is a random nonce plus a short HMAC that uses this secret. The HMAC lets the app reject a malformed handle early, before any database call.

Keep this secret separate from `SESSION_SECRET`. If a session secret leaks, it exposes auth data, but if a resource secret leaks, an attacker can forge handles. A handle cannot be rotated after it is issued, so there is no rotation list here. Only the current secret is accepted, and changing it invalidates every existing handle. Treat it as a secret, and never log a handle, because anyone who holds a handle can drive the browser it names.

## Secure cookies flag

**Recommendation:** Always set it to `true`.

The app marks all HTTP cookies as `Secure` when either of these is true:

- The app runs in production (`NODE_ENV=production`)
- The `SECURE_COOKIES` env var is set to `true`

The Dockerfile sets `NODE_ENV=production`, so Docker deployments get secure cookies from the first rule. To force secure cookies outside of production (for example, behind a TLS-terminating reverse proxy), set `SECURE_COOKIES=true`.
