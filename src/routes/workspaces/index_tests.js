import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const { createSessionCookie } = await import('../../auth/session.js');
const { routes } = await import('./index.js');
const { findOrCreateUser } = await import('../../models/users.js');
const { createWorkspace, createCollaborator, ensurePersonalWorkspace } = await import('../../models/workspaces.js');
const { closeDatabase } = await import('../../db/database.js');

test.afterEach(async () => closeDatabase());

const setupApp = () => {
  const app = new Hono();
  app.route('/workspaces', routes);
  return app;
};

let userId;
let userPublicId;
const makeSessionCookie = (over = {}) =>
  createSessionCookie({ publicId: userPublicId, email: 'user@example.com', issuedAt: Date.now(), ...over });

test('GET /workspaces redirects unauthenticated visitors to /signin', async () => {
  const app = setupApp();
  const res = await app.request('/workspaces');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin');
});

// Personal workspace from the same query, identified by pointer alone.
test("GET /workspaces lists the caller's workspace first, then their workspaces, with a Switch form per row", async () => {
  const created = await findOrCreateUser({ email: 'user@example.com' });
  userId = created.data.id;
  userPublicId = created.data.publicId;
  const personal = await ensurePersonalWorkspace({
    userId,
    email: 'user@example.com',
    personalWorkspaceId: null
  });
  const personalWorkspaceId = personal.data.workspaceId;

  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: 2345 });
  await createCollaborator({
    workspaceId: 2345,
    userId,
    email: 'user@example.com',
    role: 'Owner',
    workspaceName: 'Acme Corp'
  });

  const app = setupApp();
  // No active workspace chosen; it defaults to the caller's own (personal).
  const cookie = makeSessionCookie();
  const res = await app.request('/workspaces', { headers: { cookie: `session=${cookie}` } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /href="\/workspaces\/create"/);
  assert.match(body, />Personal</);
  assert.match(body, />Acme Corp</);
  // Active workspace shows "Active"; others get a Switch form.
  assert.match(body, />\s*Active\s*</);
  assert.match(body, /action="\/workspaces\/switch"/);
  assert.match(body, /name="workspace" value="2345"/);
  assert.match(body, />Switch</);
  assert.doesNotMatch(body, new RegExp(`href="/${personalWorkspaceId}"`), 'a workspace name is no longer a link');
  assert.doesNotMatch(body, /href="\/2345"/);
  assert.doesNotMatch(body, /Collaborators<\/a>/, 'the roster is reached from the active workspace, not a row link');
  assert.ok(
    body.indexOf('Personal') < body.indexOf('Acme Corp'),
    'the workspace leads the list however the query ordered it'
  );
});
