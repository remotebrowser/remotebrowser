import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { routes } = await import('./show.js');
const { routes: generateRoutes } = await import('./generate.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { ensurePersonalWorkspace, createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const { createApiKey, listApiKeysByUser, recordApiKeyUse } = await import('../../models/apikeys.js');
const { authenticateApiKey } = await import('../../middleware/apikey.js');
const { onRecheckApiSessions } = await import('../api/sessions.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

// Mounted after generate, as in src/routes/index.js, to prove the order holds.
const setupApp = () => {
  const app = new Hono();
  app.route('/api-keys', generateRoutes);
  app.route('/api-keys', routes);
  return app;
};

const CSRF_ID = 'a'.repeat(32);
const csrfToken = () => {
  const expires = Date.now() + 15 * 60 * 1000;
  return `${expires}.${sign(`csrf.${CSRF_ID}.${expires}`)}`;
};

const makeUser = async (email = 'user@example.com') => {
  const created = await findOrCreateUser({ email });
  const workspace = await ensurePersonalWorkspace({ userId: created.data.id, email, personalWorkspaceId: null });
  return { userId: created.data.id, publicId: created.data.publicId, email, workspaceId: workspace.data.workspaceId };
};

// Names the user's active workspace when it is not their personal one.
const cookieFor = (user) => {
  const session = { publicId: user.publicId, email: user.email, issuedAt: Date.now() };
  if (user.activeWorkspaceId) session.activeWorkspaceId = user.activeWorkspaceId;
  return `session=${createSessionCookie(session)}; csrf_id=${CSRF_ID}`;
};

const makeKey = async (user, over = {}) =>
  (
    await createApiKey({
      workspaceId: user.workspaceId,
      userId: user.userId,
      name: 'ci-runner',
      expiration: '7d',
      ...over
    })
  ).data;

const get = (path, user) => setupApp().request(path, { headers: { cookie: cookieFor(user) } });

const post = (path, user, { workspace = user.workspaceId, csrf = csrfToken() } = {}) =>
  setupApp().request(path, {
    method: 'POST',
    headers: { 'cookie': cookieFor(user), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ workspace: String(workspace), csrf }).toString()
  });

test('GET /api-keys/:id shows when the key expires, who created it, and a Delete button', async () => {
  const user = await makeUser();
  const apiKey = await makeKey(user);
  const res = await get(`/api-keys/${apiKey.publicId}`, user);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<h1>ci-runner<\/h1>/);
  assert.match(body, /Expires\s+<time datetime="[^"]+" title="[^"]+">in 7 days<\/time>\./);
  assert.match(body, /Created by user@example\.com\./);
  assert.match(body, new RegExp(`<a href="/api-keys/${apiKey.publicId}/delete" class="btn-danger">Delete</a>`));
  assert.match(body, /<a href="\/api-keys">API keys<\/a>/);
  assert.ok(!body.includes(apiKey.apiKey), 'the full key must never show again');
});

test('GET /api-keys/generate still reaches the generate page, not a key page', async () => {
  const user = await makeUser();
  const res = await get('/api-keys/generate', user);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Generate a new API key/);
});

test('the key page and its delete page answer 404 for an expired key, another user’s key, or no key', async () => {
  const user = await makeUser();
  const other = await makeUser('other@example.com');
  const expired = await makeKey(user, { expiration: '1h', now: Date.now() - 2 * 60 * 60 * 1000 });
  const theirs = await makeKey(other);
  for (const id of [expired.publicId, theirs.publicId, 'Kzzzzzz']) {
    for (const path of [`/api-keys/${id}`, `/api-keys/${id}/delete`]) {
      assert.equal((await get(path, user)).status, 404, path);
    }
    assert.equal((await post(`/api-keys/${id}/delete`, user)).status, 404, id);
  }
  assert.equal((await listApiKeysByUser({ workspaceId: other.workspaceId, userId: other.userId })).data.length, 1);
});

test('GET /api-keys/:id/delete asks to confirm, with no name to type', async () => {
  const user = await makeUser();
  const apiKey = await makeKey(user);
  const res = await get(`/api-keys/${apiKey.publicId}/delete`, user);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Deleting <strong>ci-runner<\/strong> stops it at once/);
  assert.match(body, new RegExp(`<form method="post" action="/api-keys/${apiKey.publicId}/delete"`));
  assert.match(body, /<button type="submit" class="btn-danger">Delete<\/button>/);
  assert.match(body, new RegExp(`<a href="/api-keys/${apiKey.publicId}" class="btn-secondary">Cancel</a>`));
  assert.doesNotMatch(body, /name="name"/);
});

test('POST /api-keys/:id/delete deletes the key, which stops working at once', async () => {
  const user = await makeUser();
  const apiKey = await makeKey(user);
  assert.ok((await authenticateApiKey(`Bearer ${apiKey.apiKey}`)).data);
  // Sessions the key already opened must end now, not at the next periodic check.
  let rechecks = 0;
  const stopListening = onRecheckApiSessions(() => {
    rechecks += 1;
  });
  /** @type {Response} */
  let res;
  try {
    res = await post(`/api-keys/${apiKey.publicId}/delete`, user);
  } finally {
    stopListening();
  }
  assert.equal(rechecks, 1);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/api-keys');
  assert.deepEqual((await listApiKeysByUser({ workspaceId: user.workspaceId, userId: user.userId })).data, []);
  assert.deepEqual(await authenticateApiKey(`Bearer ${apiKey.apiKey}`), { error: 'UNAUTHORIZED' });
});

test('POST /api-keys/:id/delete keeps the key on a bad CSRF token or a changed workspace', async () => {
  const user = await makeUser();
  const apiKey = await makeKey(user);
  assert.equal((await post(`/api-keys/${apiKey.publicId}/delete`, user, { csrf: 'bad' })).status, 403);
  assert.equal(
    (await post(`/api-keys/${apiKey.publicId}/delete`, user, { workspace: user.workspaceId + 1 })).status,
    409
  );
  assert.equal((await listApiKeysByUser({ workspaceId: user.workspaceId, userId: user.userId })).data.length, 1);
});

test('GET /api-keys/:id says when the key was last used, or that it never was', async () => {
  const user = await makeUser();
  const apiKey = await makeKey(user);
  assert.match(await (await get(`/api-keys/${apiKey.publicId}`, user)).text(), /<p>Never used\.<\/p>/);

  await recordApiKeyUse({ apiKeyId: apiKey.apiKeyId, now: Date.now() - 3 * 60 * 1000 });
  const body = await (await get(`/api-keys/${apiKey.publicId}`, user)).text();
  assert.match(body, /Last used\s+<time datetime="[^"]+" title="[^"]+"\s*>3 minutes ago<\/time\s*>\./);
  assert.doesNotMatch(body, /Never used/);
});

// One workspace with an Admin, and two Users who each made a key.
const makeTeam = async () => {
  const admin = await makeUser('admin@example.com');
  const alice = await makeUser('alice@example.com');
  const bob = await makeUser('bob@example.com');
  await createWorkspace({ name: 'Acme', ownerId: admin.userId, workspaceId: 3333 });
  for (const [member, role] of [
    [admin, 'Owner'],
    [alice, 'User'],
    [bob, 'User']
  ]) {
    await createCollaborator({
      workspaceId: 3333,
      userId: member.userId,
      email: member.email,
      role,
      workspaceName: 'Acme'
    });
  }
  // Each of them works in Acme, so sessions name it as the active workspace.
  const inAcme = (member) => ({ ...member, workspaceId: 3333, activeWorkspaceId: 3333 });
  return { admin: inAcme(admin), alice: inAcme(alice), bob: inAcme(bob) };
};

test('in a shared workspace, a User gets 404 for a colleague’s key, and cannot delete it', async () => {
  const { alice, bob } = await makeTeam();
  const bobsKey = await makeKey(bob);
  for (const path of [`/api-keys/${bobsKey.publicId}`, `/api-keys/${bobsKey.publicId}/delete`]) {
    assert.equal((await get(path, alice)).status, 404, path);
  }
  assert.equal((await post(`/api-keys/${bobsKey.publicId}/delete`, alice)).status, 404);
  assert.ok((await authenticateApiKey(`Bearer ${bobsKey.apiKey}`)).data);
});

test('in a shared workspace, an Admin sees anyone’s key and can revoke it', async () => {
  const { admin, bob } = await makeTeam();
  const bobsKey = await makeKey(bob);
  const page = await get(`/api-keys/${bobsKey.publicId}`, admin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Created by bob@example\.com\./);

  const res = await post(`/api-keys/${bobsKey.publicId}/delete`, admin);
  assert.equal(res.status, 303);
  assert.deepEqual(await authenticateApiKey(`Bearer ${bobsKey.apiKey}`), { error: 'UNAUTHORIZED' });
});
