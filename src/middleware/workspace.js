import { getCollaborator, listCollaboratorsByUser } from '../models/workspaces.js';
import { setActiveWorkspace } from '../auth/session.js';
import { formString } from '../form.js';

const ROLE_RANK = { User: 1, Admin: 2, Owner: 3 };

// Breadcrumb name for the workspace, clearer than bare "Personal".
const PERSONAL_WORKSPACE_LABEL = 'Personal workspace';

const hasRole = (role, minRole) => Boolean(ROLE_RANK[role]) && ROLE_RANK[role] >= ROLE_RANK[minRole];

const hasAdminRole = (role) => hasRole(role, 'Admin');

// Only the browser's creator may terminate it. Admin and Owner are exempt.
const canTerminateBrowser = (browser, workspace, user) =>
  hasAdminRole(workspace.role) || browser.creatorUserId === user.id;

const loadActiveWorkspace = async (c) => {
  const user = c.get('user');
  // The session's choice, else the workspace every user has, so a session that
  // never switched still resolves to something.
  const workspaceId = user.activeWorkspaceId || user.personalWorkspaceId;
  // It can only name an owned personal workspace, so it proves Owner rank.
  if (workspaceId === user.personalWorkspaceId) {
    return { id: workspaceId, role: 'Owner', isPersonal: true, name: PERSONAL_WORKSPACE_LABEL };
  }
  const collaborator = await getCollaborator({ workspaceId, userId: user.id });
  if (collaborator.error || !collaborator.data) {
    return null;
  }
  return { id: workspaceId, role: collaborator.data.role, isPersonal: false, name: collaborator.data.workspaceName };
};

// All collaborator workspaces, personal first; a read error empties the menu.
const loadWorkspaceSwitcherItems = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const collaborators = await listCollaboratorsByUser({ userId: user.id });
  if (collaborators.error) {
    return [];
  }
  const toItem = (collaborator) => ({
    id: collaborator.workspaceId,
    name: collaborator.workspaceId === user.personalWorkspaceId ? PERSONAL_WORKSPACE_LABEL : collaborator.workspaceName,
    isActive: collaborator.workspaceId === workspace.id
  });
  const personal = collaborators.data.filter((collaborator) => collaborator.workspaceId === user.personalWorkspaceId);
  const shared = collaborators.data.filter((collaborator) => collaborator.workspaceId !== user.personalWorkspaceId);
  return [...personal, ...shared].map(toItem);
};

const requireWorkspaceRole = (minRole) => async (c, next) => {
  const workspace = await loadActiveWorkspace(c);
  if (!workspace) {
    // The session named a workspace the caller left; drop it and land on /.
    setActiveWorkspace(c, null);
    return c.redirect('/', 303);
  }
  if (!hasRole(workspace.role, minRole)) {
    return c.text('Forbidden', 403);
  }
  c.set('workspace', workspace);
  await next();
};

// A personal workspace forbids these writes, so redirect rather than 403.
const requireSharedWorkspace = async (c, next) => {
  const workspace = c.get('workspace');
  if (workspace.isPersonal) {
    return c.redirect('/', 303);
  }
  await next();
};

// Forms embed their rendered workspace, so a switch can't reroute the write.
const requireSubmittedWorkspace = async (c, next) => {
  const body = await c.req.parseBody();
  if (Number(formString(body.workspace)) !== c.get('workspace').id) {
    return c.text('Your active workspace changed. Reload and try again.', 409);
  }
  await next();
};

// The topnav trail; the last crumb is the current page and is never a link.
const buildBreadcrumbs = (workspace, pageLabel) => {
  const crumbs = [];
  if (workspace) {
    crumbs.push({ label: workspace.name, href: '/', switcher: true });
  }
  if (pageLabel) {
    crumbs.push({ label: pageLabel, href: null });
  }
  if (crumbs.length > 0) {
    crumbs[crumbs.length - 1].href = null;
  }
  return crumbs;
};

// The browser list's own sub-pages (launch, a single browser) continue its trail
// rather than hanging off the workspace: Foo > Browsers > Launch.
const buildBrowsersBreadcrumbs = (workspace, pageLabel) => [
  { label: workspace.name, href: '/', switcher: true },
  { label: 'Browsers', href: '/browsers' },
  { label: pageLabel, href: null }
];

// Likewise for the roster's sub-pages (invite, delete): Foo > Collaborators >
// Invite. Only a shared workspace has a roster, so there is no workspace case here.
const buildCollaboratorsBreadcrumbs = (workspace, pageLabel) => [
  { label: workspace.name, href: '/', switcher: true },
  { label: 'Collaborators', href: '/workspace' },
  { label: pageLabel, href: null }
];

// A single browser's pages list continues past the browser itself, one level
// deeper than buildBrowsersBreadcrumbs: Foo > Browsers > calm-otter > Pages.
const buildBrowserPagesBreadcrumbs = (workspace, browserInstanceId, browserName) => [
  { label: workspace.name, href: '/', switcher: true },
  { label: 'Browsers', href: '/browsers' },
  { label: browserName, href: `/browsers/${browserInstanceId}` },
  { label: 'Pages', href: null }
];

// A page goes deeper: <pageId> has no name beyond the CDP target id.
const buildBrowserPageBreadcrumbs = (workspace, browserInstanceId, browserName, pageId) => [
  { label: workspace.name, href: '/', switcher: true },
  { label: 'Browsers', href: '/browsers' },
  { label: browserName, href: `/browsers/${browserInstanceId}` },
  { label: 'Pages', href: `/browsers/${browserInstanceId}/pages` },
  { label: pageId, href: null }
];

export {
  ROLE_RANK,
  hasRole,
  hasAdminRole,
  canTerminateBrowser,
  loadActiveWorkspace,
  loadWorkspaceSwitcherItems,
  requireWorkspaceRole,
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  buildBreadcrumbs,
  buildBrowsersBreadcrumbs,
  buildCollaboratorsBreadcrumbs,
  buildBrowserPagesBreadcrumbs,
  buildBrowserPageBreadcrumbs
};
