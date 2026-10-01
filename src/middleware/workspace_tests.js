import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PGLITE_DATA_DIR = 'memory://';

const {
  ROLE_RANK,
  hasRole,
  requireWorkspaceRole,
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  buildBreadcrumbs,
  buildBrowsersBreadcrumbs,
  buildCollaboratorsBreadcrumbs,
  buildBrowserPagesBreadcrumbs,
  buildBrowserPageBreadcrumbs,
  loadWorkspaceSwitcherItems
} = await import('./workspace.js');
const { createSessionCookie, readSessionCookie } = await import('../auth/session.js');
const { findOrCreateUser } = await import('../models/users.js');
const { createWorkspace, createCollaborator } = await import('../models/workspaces.js');
const { closeDatabase } = await import('../db/database.js');

test.afterEach(async () => closeDatabase());

const PERSONAL_WORKSPACE_ID = 1001;

// Cookie with active workspace (or none) so setActiveWorkspace has a real session.
const sessionCookie = (activeWorkspaceId) =>
  `session=${createSessionCookie({
    publicId: 'abcdefghi',
    email: 'user@example.com',
    issuedAt: Date.now(),
    ...(activeWorkspaceId ? { activeWorkspaceId } : {})
  })}`;

const withUserAndWorkspaceRoute = (
  minRole,
  userId,
  { personalWorkspaceId = PERSONAL_WORKSPACE_ID, activeWorkspaceId = null, extra = [] } = {}
) => {
  const path = '/x';
  const app = new Hono();
  app.use(path, async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'user@example.com',
      personalWorkspaceId,
      activeWorkspaceId
    });
    await next();
  });
  app.use(path, requireWorkspaceRole(minRole));
  for (const middleware of extra) {
    app.use(path, middleware);
  }
  app.get(path, (c) => c.json({ workspace: c.get('workspace') }));
  app.post(path, (c) => c.json({ workspace: c.get('workspace') }));
  return app;
};

const makeUser = async () => (await findOrCreateUser({ email: 'user@example.com' })).data.id;

// A real workspace + collaborator row, so getCollaborator has something to find.
const makeCollaborator = async ({ userId, workspaceId, role, workspaceName = 'Acme Corp' }) => {
  await createWorkspace({ name: workspaceName, ownerId: userId, workspaceId });
  await createCollaborator({ workspaceId, userId, email: 'user@example.com', role, workspaceName });
};

test('hasRole ranks Owner > Admin > User', () => {
  assert.equal(ROLE_RANK.Owner > ROLE_RANK.Admin, true);
  assert.equal(ROLE_RANK.Admin > ROLE_RANK.User, true);
  assert.equal(hasRole('Admin', 'User'), true);
  assert.equal(hasRole('User', 'Admin'), false);
  assert.equal(hasRole(undefined, 'User'), false);
});

test('requireWorkspaceRole falls back to the personal workspace pointer with no active workspace chosen, no database read', async () => {
  // No collaborator row exists at all; the personal-pointer branch never
  // queries one, so this would fail loudly if it ever tried.
  const userId = await makeUser();
  const app = withUserAndWorkspaceRoute('Owner', userId);
  const res = await app.request('/x', { headers: { cookie: sessionCookie(null) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    workspace: { id: PERSONAL_WORKSPACE_ID, role: 'Owner', isPersonal: true, name: 'Personal workspace' }
  });
});

test('requireWorkspaceRole resolves a chosen shared workspace through its collaborator', async () => {
  const userId = await makeUser();
  await makeCollaborator({ userId, workspaceId: 2002, role: 'Admin' });
  const app = withUserAndWorkspaceRoute('User', userId, { activeWorkspaceId: 2002 });
  const res = await app.request('/x', { headers: { cookie: sessionCookie(2002) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    workspace: { id: 2002, role: 'Admin', isPersonal: false, name: 'Acme Corp' }
  });
});

test('requireWorkspaceRole returns 403 when the caller is under-ranked in the active workspace', async () => {
  const userId = await makeUser();
  await makeCollaborator({ userId, workspaceId: 2002, role: 'User' });
  const app = withUserAndWorkspaceRoute('Admin', userId, { activeWorkspaceId: 2002 });
  const res = await app.request('/x', { headers: { cookie: sessionCookie(2002) } });
  assert.equal(res.status, 403);
});

// Visitor removed from active workspace or workspace deleted; collaborator gone.
test('requireWorkspaceRole heals a stale active workspace: clears it and redirects to /', async () => {
  const userId = await makeUser();
  const app = withUserAndWorkspaceRoute('User', userId, { activeWorkspaceId: 3003 });
  const res = await app.request('/x', { headers: { cookie: sessionCookie(3003) } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const rewritten = res.headers.get('set-cookie');
  assert.ok(rewritten, 'the stale choice must be cleared, not just bypassed once');
  const token = rewritten.split(';')[0].slice('session='.length);
  assert.equal(readSessionCookie(token).activeWorkspaceId, undefined);
});

test('requireSharedWorkspace sends a personal workspace back to /', async () => {
  const userId = await makeUser();
  const app = withUserAndWorkspaceRoute('Owner', userId, { extra: [requireSharedWorkspace] });
  const res = await app.request('/x', { headers: { cookie: sessionCookie(null) } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('requireSharedWorkspace lets a shared workspace through', async () => {
  const userId = await makeUser();
  await makeCollaborator({ userId, workspaceId: 2002, role: 'Owner' });
  const app = withUserAndWorkspaceRoute('Owner', userId, {
    activeWorkspaceId: 2002,
    extra: [requireSharedWorkspace]
  });
  const res = await app.request('/x', { headers: { cookie: sessionCookie(2002) } });
  assert.equal(res.status, 200);
});

test('requireSubmittedWorkspace passes a matching workspace and leaves the body readable for the handler', async () => {
  const userId = await makeUser();
  const app = new Hono();
  app.use('/x', async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'user@example.com',
      personalWorkspaceId: PERSONAL_WORKSPACE_ID,
      activeWorkspaceId: null
    });
    await next();
  });
  app.use('/x', requireWorkspaceRole('Owner'));
  app.use('/x', requireSubmittedWorkspace);
  app.post('/x', async (c) => {
    const body = await c.req.parseBody();
    return c.json({ name: body.name });
  });
  const res = await app.request('/x', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ workspace: PERSONAL_WORKSPACE_ID, name: 'calm-otter' }).toString()
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'calm-otter' });
});

test('requireSubmittedWorkspace 409s a mismatched workspace, and writes nothing', async () => {
  const userId = await makeUser();
  const app = withUserAndWorkspaceRoute('Owner', userId, { extra: [requireSubmittedWorkspace] });
  const res = await app.request('/x', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ workspace: 9999 }).toString()
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /active workspace changed/);
});

test('requireSubmittedWorkspace 409s a missing workspace field', async () => {
  const userId = await makeUser();
  const app = withUserAndWorkspaceRoute('Owner', userId, { extra: [requireSubmittedWorkspace] });
  const res = await app.request('/x', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({}).toString()
  });
  assert.equal(res.status, 409);
});

test('buildBreadcrumbs on a workspace homepage: Foo (current)', () => {
  assert.deepEqual(buildBreadcrumbs({ id: 1004, isPersonal: false, name: 'Foo' }), [
    { label: 'Foo', href: null, switcher: true }
  ]);
});

test('buildBreadcrumbs on a workspace sub-page: Foo (/) > Browsers (current)', () => {
  assert.deepEqual(buildBreadcrumbs({ id: 1004, isPersonal: false, name: 'Foo' }, 'Browsers'), [
    { label: 'Foo', href: '/', switcher: true },
    { label: 'Browsers', href: null }
  ]);
});

test('buildBreadcrumbs treats a personal workspace like any other workspace', () => {
  assert.deepEqual(buildBreadcrumbs({ id: 1001, isPersonal: true, name: 'Personal' }, 'Browsers'), [
    { label: 'Personal', href: '/', switcher: true },
    { label: 'Browsers', href: null }
  ]);
});

test('buildBreadcrumbs with no workspace at all and no page label: empty', () => {
  assert.deepEqual(buildBreadcrumbs(null), []);
});

test('buildBreadcrumbs with no workspace but a page label: label alone (current)', () => {
  assert.deepEqual(buildBreadcrumbs(null, 'Workspaces'), [{ label: 'Workspaces', href: null }]);
});

test('buildBrowsersBreadcrumbs hangs a browser page off the browser list, unprefixed', () => {
  assert.deepEqual(buildBrowsersBreadcrumbs({ id: 1004, name: 'Foo' }, 'Launch'), [
    { label: 'Foo', href: '/', switcher: true },
    { label: 'Browsers', href: '/browsers' },
    { label: 'Launch', href: null }
  ]);
});

test('buildCollaboratorsBreadcrumbs hangs an invite page off the roster, unprefixed', () => {
  assert.deepEqual(buildCollaboratorsBreadcrumbs({ id: 1004, name: 'Foo' }, 'Invite'), [
    { label: 'Foo', href: '/', switcher: true },
    { label: 'Collaborators', href: '/workspace' },
    { label: 'Invite', href: null }
  ]);
});

test('buildBrowserPagesBreadcrumbs hangs the pages list off its own browser', () => {
  assert.deepEqual(buildBrowserPagesBreadcrumbs({ id: 1004, name: 'Foo' }, 'Cwxyz2', 'calm-otter'), [
    { label: 'Foo', href: '/', switcher: true },
    { label: 'Browsers', href: '/browsers' },
    { label: 'calm-otter', href: '/browsers/Cwxyz2' },
    { label: 'Pages', href: null }
  ]);
});

test('buildBrowserPageBreadcrumbs hangs a single page off the pages list', () => {
  assert.deepEqual(buildBrowserPageBreadcrumbs({ id: 1004, name: 'Foo' }, 'Cwxyz2', 'calm-otter', 'page1'), [
    { label: 'Foo', href: '/', switcher: true },
    { label: 'Browsers', href: '/browsers' },
    { label: 'calm-otter', href: '/browsers/Cwxyz2' },
    { label: 'Pages', href: '/browsers/Cwxyz2/pages' },
    { label: 'page1', href: null }
  ]);
});

const withUserAndWorkspace = (
  userId,
  workspace,
  { personalWorkspaceId = PERSONAL_WORKSPACE_ID, activeWorkspaceId = null } = {}
) => {
  const path = '/x';
  const app = new Hono();
  app.use(path, async (c, next) => {
    c.set('user', { id: userId, email: 'user@example.com', personalWorkspaceId, activeWorkspaceId });
    c.set('workspace', workspace);
    await next();
  });
  app.get(path, async (c) => c.json({ items: await loadWorkspaceSwitcherItems(c) }));
  return app;
};

test('loadWorkspaceSwitcherItems lists every collaborator workspace, personal first, active one flagged', async () => {
  const userId = await makeUser();
  await createWorkspace({ name: 'Acme Corp', ownerId: userId, workspaceId: 2002 });
  await createCollaborator({
    workspaceId: 2002,
    userId,
    email: 'user@example.com',
    role: 'Admin',
    workspaceName: 'Acme Corp'
  });
  await createWorkspace({ name: 'Personal', ownerId: userId, personal: true, workspaceId: PERSONAL_WORKSPACE_ID });
  await createCollaborator({
    workspaceId: PERSONAL_WORKSPACE_ID,
    userId,
    email: 'user@example.com',
    role: 'Owner',
    workspaceName: 'Personal'
  });

  const app = withUserAndWorkspace(userId, { id: 2002, role: 'Admin', isPersonal: false, name: 'Acme Corp' });
  const res = await app.request('/x');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    items: [
      { id: PERSONAL_WORKSPACE_ID, name: 'Personal workspace', isActive: false },
      { id: 2002, name: 'Acme Corp', isActive: true }
    ]
  });
});

// A database read failure can't be reproduced against a real, healthy
// embedded PGlite instance, so the "resolves to an empty list on error"
// branch is not covered by a live test here anymore.
