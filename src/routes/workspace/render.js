import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { hasRole, buildBreadcrumbs, loadWorkspaceSwitcherItems } from '../../middleware/workspace.js';
import { listCollaboratorsByWorkspace, listInvitationsByWorkspace } from '../../models/workspaces.js';

const ROLE_OPTIONS = ['User', 'Admin'];

const renderCollaborators = async (c, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const rosterPromise = listCollaboratorsByWorkspace({ workspaceId: workspace.id });
  const invitationsPromise = listInvitationsByWorkspace({ workspaceId: workspace.id });
  const rosterResult = await rosterPromise;
  const invitationsResult = await invitationsPromise;
  return eta.render('workspace/collaborators', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    roster: rosterResult.error ? [] : rosterResult.data,
    invitations: invitationsResult.error ? [] : invitationsResult.data,
    roleOptions: ROLE_OPTIONS,
    canManage: hasRole(workspace.role, 'Admin'),
    isOwner: workspace.role === 'Owner',
    currentUserPublicId: user.publicId,
    breadcrumbs: buildBreadcrumbs(workspace, 'Collaborators'),
    ...data
  });
};

export { renderCollaborators, ROLE_OPTIONS };
