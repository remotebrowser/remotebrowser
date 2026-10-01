import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  buildCollaboratorsBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../middleware/workspace.js';
import { deleteWorkspaceCascade } from '../../models/workspaces.js';
import { formString } from '../../form.js';

export const routes = new Hono();

const renderWorkspaceDelete = async (c, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render('workspace/delete', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildCollaboratorsBreadcrumbs(workspace, 'Delete'),
    ...data
  });
};

routes.get('/delete', requireUser, requireWorkspaceRole('Owner'), requireSharedWorkspace, (c) =>
  c.html(renderWorkspaceDelete(c))
);

routes.post(
  '/delete',
  requireUser,
  requireWorkspaceRole('Owner'),
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(renderWorkspaceDelete(c, { error: 'Your session expired. Please try again.' }), 403);
    }
    const workspace = c.get('workspace');
    // Exact name match required before irreversible delete cascade.
    if (formString(body.name).trim() !== workspace.name) {
      return c.html(
        renderWorkspaceDelete(c, { error: 'That name does not match. The workspace was not deleted.' }),
        400
      );
    }
    const user = c.get('user');
    const deleted = await deleteWorkspaceCascade({ workspaceId: workspace.id });
    if (deleted.error) {
      consola.error('deleteWorkspaceCascade failed:', deleted.error);
      return c.html(renderWorkspaceDelete(c, { error: 'Unable to delete the workspace. Please try again.' }), 400);
    }
    consola.info('DELETE_WORKSPACE', {
      'event.domain': 'workspace',
      'user.id': user.id,
      'user.email': user.email,
      'workspace.id': workspace.id,
      'workspace.name': workspace.name
    });
    return c.redirect('/workspaces', 303);
  }
);
