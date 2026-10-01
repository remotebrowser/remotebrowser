import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../../auth/session.js');
const { routes } = await import('./sent.js');
const { findOrCreateUser } = await import('../../../models/users.js');
const { createWorkspace, createCollaborator } = await import('../../../models/workspaces.js');
const { closeDatabase } = await import('../../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/workspace/invite', routes);
  return app;
};

let userId;
let userPublicId;
const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

const SHARED_WORKSPACE_ID = 2345;

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

const ownerSession = (activeWorkspaceId = SHARED_WORKSPACE_ID) =>
  makeSessionCookie({ activeWorkspaceId: activeWorkspaceId });

test('GET /workspace/invite/sent shows the invited address for the active workspace', async () => {
  await makeCollaborator({ role: 'Owner' });
  const res = await setupApp().request('/workspace/invite/sent?email=new%40example.com', {
    headers: { cookie: `session=${ownerSession()}` }
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Invite sent/);
  assert.match(body, /new@example\.com/);
  assert.match(body, /spam folder/);
  // The breadcrumb is the only way back, so the page carries no back-link.
  assert.doesNotMatch(body, /Back to/);
  assert.match(body, /href="\/workspace">\s*Collaborators/);
  assert.match(body, /class="breadcrumb-switcher-trigger">Acme Corp</);
});

test('GET /workspace/invite/sent sends a personal workspace back to /', async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const app = setupApp();
  const cookie = makeSessionCookie();
  const res = await app.request('/workspace/invite/sent?email=someone@example.com', {
    headers: { cookie: `session=${cookie}` }
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});
