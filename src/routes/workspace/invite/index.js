import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../../auth/csrf.js';
import { requireUser } from '../../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  buildCollaboratorsBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../../middleware/workspace.js';
import { createInvitation } from '../../../models/workspaces.js';
import { sendSignInLink } from '../../../auth/magic.js';
import { formString } from '../../../form.js';
import { isEmailAddress } from '../../../email.js';
import { absoluteOrigin } from '../../../origin.js';

export const routes = new Hono();

// Invited collaborators always join as a User; an Admin can promote them from the
// collaborators page once they have claimed the invite.
const INVITE_ROLE = 'User';

const renderWorkspaceInvite = async (c, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render('workspace/invite', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildCollaboratorsBreadcrumbs(workspace, 'Invite'),
    ...data
  });
};

routes.get('/', requireUser, requireWorkspaceRole('Admin'), requireSharedWorkspace, (c) =>
  c.html(renderWorkspaceInvite(c))
);

routes.post(
  '/',
  requireUser,
  requireWorkspaceRole('Admin'),
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(renderWorkspaceInvite(c, { error: 'Your session expired. Please try again.' }), 403);
    }
    const email = formString(body.email).trim().toLowerCase();
    if (!isEmailAddress(email)) {
      return c.html(renderWorkspaceInvite(c, { error: 'A valid email address is required.' }), 400);
    }
    const user = c.get('user');
    const workspace = c.get('workspace');
    const created = await createInvitation({
      workspaceId: workspace.id,
      email,
      role: INVITE_ROLE,
      workspaceName: workspace.name
    });
    if (created.error) {
      consola.error('createInvitation failed:', created.error);
      return c.html(renderWorkspaceInvite(c, { error: 'Unable to send the invite. Please try again.' }), 400);
    }
    consola.info('INVITE_COLLABORATOR', {
      'event.domain': 'workspace',
      'user.id': user.id,
      'user.email': user.email,
      'workspace.id': workspace.id,
      'workspace.name': workspace.name,
      'collaborator.email': email
    });
    const sent = await sendSignInLink(email, `${absoluteOrigin(c)}/continue`);
    if (sent.error) {
      consola.error('sendSignInLink (invite) failed:', sent.error);
    }
    // Confirmation URL so a reload never re-sends; email is in the query string.
    return c.redirect(`/workspace/invite/sent?email=${encodeURIComponent(email)}`, 303);
  }
);
