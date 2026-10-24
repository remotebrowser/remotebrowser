import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { consola } from 'consola/basic';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { sign } = await import('../../auth/signing.js');
const { routes, generateApiKeyName } = await import('./generate.js');
const { FLOWER_ADJECTIVES, FLOWERS } = await import('../../wordlist.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { listApiKeysByUser, createApiKey } = await import('../../models/apikeys.js');
const { isWellFormedApiKey } = await import('../../apikey.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  // Stands in for what secureHeaders sets before the route runs in production.
  app.use((c, next) => {
    c.set('secureHeadersNonce', 'test-nonce');
    return next();
  });
  app.route('/api-keys', routes);
  return app;
};

let userId;
let userPublicId;

const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

// Mirrors csrf.js's CSRF token TTL so the minted token is unexpired when verified.
const CSRF_TTL_MS = 15 * 60 * 1000;
const CSRF_ID = 'a'.repeat(32);
const makeCsrfToken = () => {
  const expires = Date.now() + CSRF_TTL_MS;
  return `${expires}.${sign(`csrf.${CSRF_ID}.${expires}`)}`;
};

const makeUser = async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const workspace = await ensurePersonalWorkspace({ userId, email: 'user@example.com', personalWorkspaceId: null });
  return workspace.data.workspaceId;
};

const post = (app, form, { csrf = makeCsrfToken(), session = {} } = {}) =>
  app.request('/api-keys/generate', {
    method: 'POST',
    headers: {
      'cookie': `session=${makeSessionCookie(session)}; csrf_id=${CSRF_ID}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ csrf, ...form }).toString()
  });

test('GET /api-keys/generate redirects an anonymous visitor to /signin', async () => {
  const res = await setupApp().request('/api-keys/generate');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

const FLOWER_NAME = /^[a-z]+-[a-z]+$/;

test('generateApiKeyName suggests an adjective and a flower, like a browser name', () => {
  const names = new Set(Array.from({ length: 50 }, () => generateApiKeyName()));
  for (const name of names) {
    const [adjective, flower] = name.split('-');
    assert.match(name, FLOWER_NAME);
    assert.ok(FLOWER_ADJECTIVES.includes(adjective), adjective);
    assert.ok(FLOWERS.includes(flower), flower);
  }
  assert.ok(names.size > 1, 'the suggestion should vary');
});

test('GET /api-keys/generate suggests a name, and picks 7 days as the expiration', async () => {
  await makeUser();
  const res = await setupApp().request('/api-keys/generate', {
    headers: { cookie: `session=${makeSessionCookie()}` }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<form method="post" action="\/api-keys\/generate"/);
  const suggested = body.match(/<input type="text" id="name" name="name" value="([^"]*)" required maxlength="80"/)[1];
  assert.match(suggested, FLOWER_NAME);
  assert.match(body, /<div class="radio-group" role="radiogroup" aria-labelledby="expiration-label">/);
  assert.match(body, /<span class="field-label" id="expiration-label">Expiration<\/span>/);
  for (const [value, label] of [
    ['1h', '1 hour'],
    ['1d', '1 day'],
    ['30d', '30 days'],
    ['90d', '90 days']
  ]) {
    assert.match(body, new RegExp(`<input type="radio" name="expiration" value="${value}" required />\\s*${label}`));
  }
  assert.match(body, /<input type="radio" name="expiration" value="7d" required checked \/>\s*7 days/);
  assert.equal((body.match(/ checked /g) || []).length, 1, 'only one expiration is picked');
  assert.match(body, /<a href="\/api-keys">API keys<\/a>/);
  assert.match(body, /aria-current="page">Generate/);
});

test('POST /api-keys/generate shows the new key once, bound to the active workspace and its creator', async () => {
  const workspaceId = await makeUser();
  const res = await post(setupApp(), { workspace: String(workspaceId), name: 'ci-runner', expiration: '7d' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  const shown = body.match(/<span class="api-key-value">([^<]+)<\/span>/)[1];
  assert.ok(isWellFormedApiKey(shown), `not an API key: ${shown}`);
  assert.match(shown, /^sk-rb-v1-/);
  assert.match(body, /will not be\s+shown\s+again/);
  // Masked, same length as the key, with Copy still taking the real one.
  const mask = body.match(/<span class="api-key-mask">([^<]+)<\/span>/)[1];
  assert.equal(mask, `sk-rb-v1-${'•'.repeat(shown.length - 'sk-rb-v1-'.length)}`);
  assert.match(body, new RegExp(`class="instruction-block api-key-block" data-copy-value="${shown}"`));
  // Hidden until the inline script reveals them, so they never show without JavaScript.
  const toggleAt = body.search(
    /<button type="button" class="btn-secondary api-key-toggle hidden"[^>]*aria-pressed="false">\s*View Key\s*<\/button>/
  );
  const copyAt = body.search(/<button type="button" class="btn-primary code-copy-button hidden">Copy<\/button>/);
  assert.ok(toggleAt > -1 && copyAt > -1, 'both buttons are there');
  assert.ok(copyAt < toggleAt, 'Copy sits to the left of View Key');
  assert.match(body, /<script nonce="test-nonce">/);
  assert.doesNotMatch(body, /expires at|Back to the workspace/);

  const listed = (await listApiKeysByUser({ workspaceId, userId })).data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'ci-runner');
  assert.equal(listed[0].creatorUserId, userId);
  const days = (listed[0].expiresTimestamp - listed[0].createdTimestamp) / (24 * 60 * 60 * 1000);
  assert.equal(days, 7);
});

test('POST /api-keys/generate binds the key to a shared workspace when that one is active', async () => {
  await makeUser();
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });
  const res = await post(
    setupApp(),
    { workspace: '3333', name: 'acme', expiration: '1d' },
    { session: { activeWorkspaceId: 3333 } }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await listApiKeysByUser({ workspaceId: 3333, userId })).data.map((key) => key.name),
    ['acme']
  );
});

test('POST /api-keys/generate refuses a missing name or an expiration that is not offered', async () => {
  const workspaceId = await makeUser();
  const app = setupApp();
  for (const [form, message] of [
    [{ name: '  ', expiration: '1d' }, /A name \(up to 80 characters\) is required\./],
    [{ name: 'x'.repeat(81), expiration: '1d' }, /A name \(up to 80 characters\) is required\./],
    [{ name: 'ci', expiration: '' }, /Choose when the API key expires\./],
    [{ name: 'ci', expiration: '365d' }, /Choose when the API key expires\./]
  ]) {
    const res = await post(app, { workspace: String(workspaceId), ...form });
    assert.equal(res.status, 400);
    assert.match(await res.text(), message);
  }
  assert.deepEqual((await listApiKeysByUser({ workspaceId, userId })).data, []);
});

test('POST /api-keys/generate keeps the submitted values after an error', async () => {
  const workspaceId = await makeUser();
  const res = await post(setupApp(), { workspace: String(workspaceId), name: '', expiration: '30d' });
  const body = await res.text();
  assert.match(body, /<input type="radio" name="expiration" value="30d" required checked \/>/);
  assert.equal((body.match(/ checked /g) || []).length, 1);
  assert.match(body, /id="name" name="name" value=""/, 'a cleared name stays cleared');
});

test('POST /api-keys/generate refuses a bad CSRF token', async () => {
  const workspaceId = await makeUser();
  const res = await post(setupApp(), { workspace: String(workspaceId), name: 'ci', expiration: '1d' }, { csrf: 'bad' });
  assert.equal(res.status, 403);
  assert.deepEqual((await listApiKeysByUser({ workspaceId, userId })).data, []);
});

// The form names the workspace it was rendered for, so a switch in another tab
// cannot bind the key to a different workspace.
test('POST /api-keys/generate refuses when the active workspace changed since the form was rendered', async () => {
  const workspaceId = await makeUser();
  const res = await post(setupApp(), { workspace: String(workspaceId + 1), name: 'ci', expiration: '1d' });
  assert.equal(res.status, 409);
  assert.deepEqual((await listApiKeysByUser({ workspaceId, userId })).data, []);
});

test('POST /api-keys/generate logs the new key by its public id, never the key itself', async () => {
  const workspaceId = await makeUser();
  const calls = [];
  const original = consola.info;
  consola.info = (...args) => calls.push(args);
  /** @type {Response} */
  let res;
  try {
    res = await post(setupApp(), { workspace: String(workspaceId), name: 'ci-runner', expiration: '7d' });
  } finally {
    consola.info = original;
  }
  const shown = (await res.text()).match(/<span class="api-key-value">([^<]+)<\/span>/)[1];
  const created = calls.find(([message]) => message === 'API key created');
  assert.ok(created, 'the creation must be logged');
  const [listed] = (await listApiKeysByUser({ workspaceId, userId })).data;
  assert.equal(created[1]['event.domain'], 'api');
  assert.equal(created[1]['rb.api_key'], listed.publicId);
  assert.equal(created[1]['user.id'], userId);
  assert.equal(created[1]['workspace.id'], workspaceId);
  for (const call of calls) {
    assert.ok(!JSON.stringify(call).includes(shown), 'the key must never be logged');
  }
});

const fillKeys = async (workspaceId, count) => {
  for (let i = 0; i < count; i += 1) {
    await createApiKey({ workspaceId, userId, name: `key-${i}`, expiration: '1d' });
  }
};

test('GET /api-keys/generate explains the limit instead of the form once a personal workspace has 10 keys', async () => {
  const workspaceId = await makeUser();
  await fillKeys(workspaceId, 10);
  const res = await setupApp().request('/api-keys/generate', { headers: { cookie: `session=${makeSessionCookie()}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /You've reached the limit of 10 API keys in this workspace\./);
  assert.match(body, /<a href="\/api-keys">your API keys<\/a>/);
  assert.doesNotMatch(body, /<form method="post" action="\/api-keys\/generate"/);
});

test('POST /api-keys/generate answers 409 and creates nothing once a personal workspace has 10 keys', async () => {
  const workspaceId = await makeUser();
  await fillKeys(workspaceId, 10);
  const res = await post(setupApp(), { workspace: String(workspaceId), name: 'eleventh', expiration: '1d' });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /You've reached the limit of 10 API keys/);
  assert.equal((await listApiKeysByUser({ workspaceId, userId })).data.length, 10);
});

// Each member of a shared workspace counts on their own.
test('POST /api-keys/generate allows 5 keys per member in a shared workspace', async () => {
  await makeUser();
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: 3333 });
  await createCollaborator({
    workspaceId: 3333,
    userId,
    email: 'user@example.com',
    role: 'User',
    workspaceName: 'Acme Corp'
  });
  const inAcme = { session: { activeWorkspaceId: 3333 } };
  await fillKeys(3333, 4);
  const fifth = await post(setupApp(), { workspace: '3333', name: 'fifth', expiration: '1d' }, inAcme);
  assert.equal(fifth.status, 200);
  const sixth = await post(setupApp(), { workspace: '3333', name: 'sixth', expiration: '1d' }, inAcme);
  assert.equal(sixth.status, 409);
  assert.match(await sixth.text(), /You've reached the limit of 5 API keys in this workspace\./);
  assert.equal((await listApiKeysByUser({ workspaceId: 3333, userId })).data.length, 5);
});
