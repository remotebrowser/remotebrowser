import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { sign } = await import('../auth/signing.js');
const { createSessionCookie, readSessionCookie } = await import('../auth/session.js');
const { createNonce } = await import('../auth/nonce.js');
const { client } = await import('../middleware/client.js');
const { routes } = await import('./continue.js');
const { getUser, getUserByPublicId, findOrCreateUser, recordSigninCode } = await import('../models/users.js');
const { getCollaborator, ensurePersonalWorkspace, createInvitation, listInvitationsByEmail, createWorkspace } =
  await import('../models/workspaces.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.use('*', client);
  app.route('/continue', routes);
  return app;
};

const makeSessionCookie = (publicId) =>
  createSessionCookie({ publicId, email: 'user@example.com', issuedAt: Date.now() });

// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const makeCsrfToken = (csrfId) => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${csrfId}.${expires}`)}`;
};

// Seeds a fresh sign-in nonce the same way /sent does, so the route's
// verification has a real nonce to consume.
const makeNonce = async (email) => {
  const { token, expires, nonce } = createNonce(email);
  await recordSigninCode({ token, email, expires });
  return nonce;
};

const postContinue = (app, csrfId, body = {}, headers = {}) =>
  app.request('/continue', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cookie': `csrf_id=${csrfId}`, ...headers },
    body: new URLSearchParams({
      email: 'user@example.com',
      nonce: 'placeholder',
      csrf: makeCsrfToken(csrfId),
      ...body
    }).toString()
  });

const sessionFromResponse = (res) => {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('session='));
  if (!cookie) return null;
  const match = cookie.match(/^session=([^;]*)/);
  return match ? readSessionCookie(decodeURIComponent(match[1])) : null;
};

test('GET /continue renders the form for anonymous visitors, reflecting the nonce query param', async () => {
  const app = setupApp();
  const res = await app.request('/continue?nonce=abc123');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /name="nonce" value="abc123"/);
});

test('GET /continue redirects an authenticated user to /', async () => {
  // A real user row: a session naming nobody is treated as signed out.
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const app = setupApp();
  const res = await app.request('/continue', {
    headers: { cookie: `session=${makeSessionCookie(created.data.publicId)}` }
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('POST /continue rejects a missing or invalid CSRF token', async () => {
  const app = setupApp();
  const res = await postContinue(app, 'unused', { csrf: 'bogus' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Your session expired/);
});

test('POST /continue rejects a missing nonce', async () => {
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce: '' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /sign-in link is invalid or has expired/);
});

test('POST /continue signs the user in and redirects to /', async () => {
  const nonce = await makeNonce('user@example.com');
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith('session=')));
  assert.ok(cookies.some((c) => c.startsWith('signin_email=;')));
  assert.equal(typeof sessionFromResponse(res).publicId, 'string', 'the new session must carry a public id');
});

test('POST /continue records user access using the signed-in id and email', async () => {
  const nonce = await makeNonce('user@example.com');
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce });
  assert.equal(res.status, 303);

  const session = sessionFromResponse(res);
  const user = await getUserByPublicId({ publicId: session.publicId });
  assert.equal(user.data.email, 'user@example.com');
});

// Build workspace preemptively; GET / would create one if this fails.
test('POST /continue gives a brand-new user their personal workspace', async () => {
  const nonce = await makeNonce('user@example.com');
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce });

  const session = sessionFromResponse(res);
  const user = await getUserByPublicId({ publicId: session.publicId });
  assert.ok(Number.isSafeInteger(user.data.personalWorkspaceId));
  const seat = await getCollaborator({ workspaceId: user.data.personalWorkspaceId, userId: user.data.id });
  assert.equal(seat.data.role, 'Owner');
  assert.equal(seat.data.workspaceName, 'Personal');
});

test('POST /continue maps an existing email to its existing account, building no new workspace', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  const existing = await ensurePersonalWorkspace({
    userId: created.data.id,
    email: 'user@example.com',
    personalWorkspaceId: null
  });

  const nonce = await makeNonce('user@example.com');
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce });
  assert.equal(res.status, 303);

  const session = sessionFromResponse(res);
  assert.equal(session.publicId, created.data.publicId, 'a returning email must resolve to its existing public id');
  const user = await getUser({ id: created.data.id });
  assert.equal(user.data.personalWorkspaceId, existing.data.workspaceId, 'a returning user keeps their own workspace');
});

test('POST /continue claims pending invitations for the signed-in email into a collaborator seat', async () => {
  const inviter = await findOrCreateUser({ email: 'inviter@example.com' });
  await createWorkspace({ name: 'Acme Corp', ownerId: inviter.data.id, workspaceId: 2002 });
  await createInvitation({
    workspaceId: 2002,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });

  const nonce = await makeNonce('user@example.com');
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce });
  assert.equal(res.status, 303);

  const session = sessionFromResponse(res);
  const signedIn = await getUserByPublicId({ publicId: session.publicId });
  const seat = await getCollaborator({ workspaceId: 2002, userId: signedIn.data.id });
  assert.equal(seat.data.role, 'User');
  assert.equal(seat.data.workspaceName, 'Acme Corp');

  const invitations = await listInvitationsByEmail({ email: 'user@example.com' });
  assert.deepEqual(invitations.data, [], 'the claimed invitation should be deleted');
});

// The fail-open behavior for a claim/write error (src/routes/continue.js
// logs and continues rather than blocking sign-in) can't be reproduced
// against a real, healthy embedded PGlite instance, so it is not covered by
// a live test here anymore - it is visible directly in the route's source
// instead.

test('POST /continue reports an error when the sign-in link is invalid', async () => {
  const app = setupApp();
  const res = await postContinue(app, 'a'.repeat(32), { nonce: 'not-a-real-nonce' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /sign-in link is invalid or has expired/);
});

test('POST /continue rejects a replayed sign-in link: a nonce is single-use', async () => {
  const nonce = await makeNonce('user@example.com');
  const app = setupApp();
  const first = await postContinue(app, 'a'.repeat(32), { nonce });
  assert.equal(first.status, 303);

  const second = await postContinue(app, 'b'.repeat(32), { nonce });
  assert.equal(second.status, 401);
});
