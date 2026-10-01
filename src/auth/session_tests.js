import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Set config env vars before config.js loads, with two comma-separated secrets so previousSessionSecret is populated below.
Object.assign(process.env, {
  SESSION_SECRET: `${'a'.repeat(64)},${'b'.repeat(64)}`
});

const { default: crypto } = await import('node:crypto');
const { config } = await import('../config.js');
const { sign } = await import('./signing.js');
const {
  createSessionCookie,
  readSessionCookie,
  sessionRemainingSeconds,
  setSessionCookie,
  setActiveWorkspace,
  createSigninEmailCookie,
  readSigninEmailCookie
} = await import('./session.js');

const withRoute = (handler) => {
  const app = new Hono();
  app.get('/x', handler);
  return app;
};

const extractCookieValue = (setCookieHeader, name) => {
  const match = (setCookieHeader || '').match(new RegExp(`^${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
};

test('createSessionCookie/readSessionCookie round-trip a session payload', () => {
  const session = { publicId: 'abcdefghi', email: 'user@example.com', issuedAt: Date.now() };
  assert.deepEqual(readSessionCookie(createSessionCookie(session)), session);
});

test('readSessionCookie rejects a tampered cookie', () => {
  const cookie = createSessionCookie({ publicId: 'abcdefghi', email: 'b', issuedAt: Date.now() });
  assert.equal(readSessionCookie(`${cookie.slice(0, -4)}abcd`), null);
});

test('readSessionCookie rejects non-string input', () => {
  assert.equal(readSessionCookie(undefined), null);
  assert.equal(readSessionCookie(null), null);
});

test('readSessionCookie rejects a cookie with the wrong number of parts', () => {
  assert.equal(readSessionCookie('only-one-part'), null);
});

test('readSessionCookie rejects a session missing publicId/email', () => {
  assert.equal(readSessionCookie(createSessionCookie({ issuedAt: Date.now() })), null);
});

test('readSessionCookie rejects a session issued before sessionNotBefore', () => {
  const cookie = createSessionCookie({ publicId: 'abcdefghi', email: 'b', issuedAt: config.sessionNotBefore - 1 });
  assert.equal(readSessionCookie(cookie), null);
});

test('readSessionCookie accepts a session encrypted with the previous session secret', () => {
  const key = crypto.createHmac('sha256', config.previousSessionSecret).update('session-cookie-encryption').digest();
  const session = { publicId: 'abcdefghi', email: 'b', issuedAt: Date.now() };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  const cookie = [iv, ciphertext, cipher.getAuthTag()].map((buf) => buf.toString('base64url')).join('.');
  assert.deepEqual(readSessionCookie(cookie), session);
});

test('readSessionCookie rejects a session encrypted with an unrelated key', () => {
  const key = crypto.createHmac('sha256', 'some-unrelated-secret').update('session-cookie-encryption').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ publicId: 'abcdefghi', email: 'b', issuedAt: Date.now() }), 'utf8'),
    cipher.final()
  ]);
  const cookie = [iv, ciphertext, cipher.getAuthTag()].map((buf) => buf.toString('base64url')).join('.');
  assert.equal(readSessionCookie(cookie), null);
});

test('setSessionCookie sets an HttpOnly session cookie readable by readSessionCookie', async () => {
  const session = { publicId: 'abcdefghi', email: 'user@example.com', issuedAt: Date.now() };
  const app = withRoute((c) => {
    setSessionCookie(c, session);
    return c.text('ok');
  });
  const res = await app.request('/x');
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.deepEqual(readSessionCookie(extractCookieValue(setCookie, 'session')), session);
});

test('createSigninEmailCookie/readSigninEmailCookie round-trip an email across requests', async () => {
  const createApp = withRoute((c) => {
    createSigninEmailCookie(c, 'user@example.com');
    return c.text('ok');
  });
  const createRes = await createApp.request('/x');
  const value = extractCookieValue(createRes.headers.get('set-cookie'), 'signin_email');

  const readApp = withRoute((c) => c.text(readSigninEmailCookie(c) || ''));
  const readRes = await readApp.request('/x', { headers: { cookie: `signin_email=${value}` } });
  assert.equal(await readRes.text(), 'user@example.com');
});

test('readSigninEmailCookie returns null when there is no cookie', async () => {
  const app = withRoute((c) => c.json({ email: readSigninEmailCookie(c) }));
  const res = await app.request('/x');
  assert.equal((await res.json()).email, null);
});

test('readSigninEmailCookie returns null for an expired cookie', async () => {
  const expires = Date.now() - 1000;
  const emailB64 = Buffer.from('user@example.com').toString('base64url');
  const token = `${expires}.${emailB64}.${sign(`signinemail.${expires}.${emailB64}`)}`;
  const app = withRoute((c) => c.json({ email: readSigninEmailCookie(c) }));
  const res = await app.request('/x', { headers: { cookie: `signin_email=${token}` } });
  assert.equal((await res.json()).email, null);
});

test('readSigninEmailCookie returns null for a tampered cookie', async () => {
  const expires = Date.now() + 1000;
  const emailB64 = Buffer.from('user@example.com').toString('base64url');
  const token = `${expires}.${emailB64}.tampered-signature`;
  const app = withRoute((c) => c.json({ email: readSigninEmailCookie(c) }));
  const res = await app.request('/x', { headers: { cookie: `signin_email=${token}` } });
  assert.equal((await res.json()).email, null);
});

// Max-Age is only a browser hint; a replayed stolen cookie ignores it, so age must be enforced on every read.
test('readSessionCookie rejects a cookie older than the session TTL', () => {
  const stale = { publicId: 'abcdefghi', email: 'r', issuedAt: Date.now() - (config.sessionTtlSeconds * 1000 + 1000) };
  assert.equal(readSessionCookie(createSessionCookie(stale)), null);
});

test('readSessionCookie accepts a cookie still inside the session TTL', () => {
  const fresh = { publicId: 'abcdefghi', email: 'r', issuedAt: Date.now() - (config.sessionTtlSeconds * 1000 - 5000) };
  assert.deepEqual(readSessionCookie(createSessionCookie(fresh)), fresh);
});

test('readSessionCookie rejects a cookie issued in the future beyond the TTL window', () => {
  const skewed = { publicId: 'abcdefghi', email: 'r', issuedAt: Date.now() + 60_000 };
  // A future issuedAt shortens nothing, so it stays valid: only age is capped.
  assert.deepEqual(readSessionCookie(createSessionCookie(skewed)), skewed);
});

test('sessionRemainingSeconds counts down from issuedAt rather than restarting the clock', () => {
  const halfway = { publicId: 'abcdefghi', email: 'r', issuedAt: Date.now() - (config.sessionTtlSeconds * 1000) / 2 };
  const remaining = sessionRemainingSeconds(halfway);
  assert.ok(
    Math.abs(remaining - config.sessionTtlSeconds / 2) < 5,
    `expected about half the TTL to remain, got ${remaining}`
  );
  assert.equal(sessionRemainingSeconds({ issuedAt: Date.now() - config.sessionTtlSeconds * 2000 }), 0);
});

test('a session round-trips the active workspace', () => {
  const session = {
    publicId: 'abcdefghi',
    email: 'user@example.com',
    issuedAt: Date.now(),
    activeWorkspaceId: 1234
  };
  assert.deepEqual(readSessionCookie(createSessionCookie(session)), session);
});

// A cookie created before the workspace was carried in the session is still a valid
// session; it just has no workspace chosen yet.
test('readSessionCookie accepts a session with no active workspace, and drops a malformed one', () => {
  const base = { publicId: 'abcdefghi', email: 'user@example.com', issuedAt: Date.now() };
  const read = readSessionCookie(createSessionCookie(base));
  assert.equal('activeWorkspaceId' in read, false);
  const malformed = readSessionCookie(createSessionCookie({ ...base, activeWorkspaceId: 'nope' }));
  assert.ok(malformed, 'a bad workspace must not invalidate the credential it rides with');
  assert.equal('activeWorkspaceId' in malformed, false);
});

test('setActiveWorkspace rewrites the session cookie with the chosen workspace, and clears it', async () => {
  const session = { publicId: 'abcdefghi', email: 'user@example.com', issuedAt: Date.now() };
  const cookie = `session=${createSessionCookie(session)}`;

  const switchApp = withRoute((c) => c.text(String(setActiveWorkspace(c, 1234))));
  const switched = await switchApp.request('/x', { headers: { cookie } });
  assert.equal(await switched.text(), 'true');
  const rewritten = extractCookieValue(switched.headers.get('set-cookie'), 'session');
  assert.deepEqual(readSessionCookie(rewritten), { ...session, activeWorkspaceId: 1234 });

  const clearApp = withRoute((c) => c.text(String(setActiveWorkspace(c, null))));
  const cleared = await clearApp.request('/x', { headers: { cookie: `session=${rewritten}` } });
  assert.deepEqual(readSessionCookie(extractCookieValue(cleared.headers.get('set-cookie'), 'session')), session);
});

test('setActiveWorkspace reports failure and sets nothing when there is no session to amend', async () => {
  const app = withRoute((c) => c.text(String(setActiveWorkspace(c, 1234))));
  const res = await app.request('/x');
  assert.equal(await res.text(), 'false');
  assert.equal(res.headers.get('set-cookie'), null);
});
