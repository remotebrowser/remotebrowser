import { Hono } from 'hono';
import { eta } from '../../../render.js';
import { createCsrfToken } from '../../../auth/csrf.js';
import { requireUser } from '../../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSharedWorkspace,
  buildCollaboratorsBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../../middleware/workspace.js';
import { formString } from '../../../form.js';

export const routes = new Hono();

routes.get('/sent', requireUser, requireWorkspaceRole('Admin'), requireSharedWorkspace, async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return c.html(
    eta.render('workspace/invite-sent', {
      email: user.email,
      csrfToken: createCsrfToken(c),
      workspace,
      workspaces: await loadWorkspaceSwitcherItems(c),
      invitedEmail: formString(c.req.query('email')).trim().toLowerCase(),
      breadcrumbs: buildCollaboratorsBreadcrumbs(workspace, 'Invite')
    })
  );
});
