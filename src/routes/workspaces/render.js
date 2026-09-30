import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { buildBreadcrumbs } from '../../middleware/workspace.js';
import { listCollaboratorsByUser } from '../../models/workspaces.js';

// Personal workspace is an ordinary Collaborator record and leads the list.
const renderWorkspaces = async (c, data = {}) => {
  const user = c.get('user');
  const listResult = await listCollaboratorsByUser({ userId: user.id });
  const collaborators = listResult.error ? [] : listResult.data;
  const personal = collaborators.filter((collaborator) => collaborator.workspaceId === user.personalWorkspaceId);
  const shared = collaborators.filter((collaborator) => collaborator.workspaceId !== user.personalWorkspaceId);
  return eta.render('workspaces/index', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    collaborators: [...personal, ...shared],
    personalWorkspaceId: user.personalWorkspaceId,
    activeWorkspaceId: user.activeWorkspaceId || user.personalWorkspaceId,
    breadcrumbs: buildBreadcrumbs(null, 'Workspaces'),
    ...data
  });
};

export { renderWorkspaces };
