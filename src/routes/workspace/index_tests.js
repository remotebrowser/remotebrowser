import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./index.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator } = await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/workspace', routes);
  return app;
};

let userId;
let userPublicId;
const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

const SHARED_WORKSPACE_ID = 2345;

const ownerSession = (activeWorkspaceId = SHARED_WORKSPACE_ID) =>
  makeSessionCookie({ activeWorkspaceId: activeWorkspaceId });

const makeCollaborator = async ({
  workspaceId = SHARED_WORKSPACE_ID,
  role = 'Owner',
  workspaceName = 'Acme Corp'
} = {}) => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  await createWorkspace({ name: workspaceName, ownerId: userId, workspaceId });
  await createCollaborator({ workspaceId, userId, email: 'user@example.com', role, workspaceName });
};

test('GET /workspace redirects to / and clears a stale active workspace', async () => {
  // The user exists (so requireUser succeeds) but has no seat in 2345 at all.
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const app = setupApp();
  const res = await app.request('/workspace', { headers: { cookie: `session=${ownerSession()}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('GET /workspace shows the roster and pending invites for the active workspace', async () => {
  await makeCollaborator({ role: 'Owner' });
  const app = setupApp();
  const res = await app.request('/workspace', { headers: { cookie: `session=${ownerSession()}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /user@example\.com/);
  assert.doesNotMatch(body, /Pending invite/);
  assert.match(body, /href="\/workspace\/invite"/);
  assert.match(body, /href="\/workspace\/delete"/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
  assert.match(body, /aria-current="page">Collaborators/);
  assert.doesNotMatch(body, /<a href="\/workspaces">/, 'the Workspaces crumb is gone from the trail');
});

test('GET /workspace sends a personal workspace back to /', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/workspace', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});
