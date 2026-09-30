import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import { requireWorkspaceRole, requireSharedWorkspace, requireSubmittedWorkspace } from '../../middleware/workspace.js';
import { getCollaborator, updateCollaboratorRole } from '../../models/workspaces.js';
import { getUserByPublicId } from '../../models/users.js';
import { formString } from '../../form.js';
import { renderCollaborators, ROLE_OPTIONS } from './render.js';
import { outranks } from './permissions.js';

export const routes = new Hono();

routes.post(
  '/:publicId/role',
  requireUser,
  requireWorkspaceRole('Admin'),
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(await renderCollaborators(c, { error: 'Your session expired. Please try again.' }), 403);
    }
    const role = formString(body.role);
    if (!ROLE_OPTIONS.includes(role)) {
      return c.html(await renderCollaborators(c, { error: 'Choose a valid role.' }), 400);
    }
    const workspace = c.get('workspace');
    const targetUser = await getUserByPublicId({ publicId: c.req.param('publicId') });
    if (targetUser.error || !targetUser.data) {
      return c.html(await renderCollaborators(c, { error: 'That collaborator could not be found.' }), 400);
    }
    const targetUserId = targetUser.data.id;
    const target = await getCollaborator({ workspaceId: workspace.id, userId: targetUserId });
    if (target.error || !target.data) {
      return c.html(await renderCollaborators(c, { error: 'That collaborator could not be found.' }), 400);
    }
    if (target.data.role === 'Owner') {
      return c.html(await renderCollaborators(c, { error: 'Transfer ownership to change the owner.' }), 400);
    }
    if (!outranks({ actingRole: workspace.role, targetRole: target.data.role })) {
      return c.html(
        await renderCollaborators(c, {
          error: 'You cannot change the role of a collaborator at or above your own rank.'
        }),
        403
      );
    }
    const updated = await updateCollaboratorRole({
      workspaceId: workspace.id,
      userId: targetUserId,
      role
    });
    if (updated.error) {
      consola.error('updateCollaboratorRole failed:', updated.error);
      return c.html(await renderCollaborators(c, { error: 'Unable to update the role. Please try again.' }), 400);
    }
    return c.redirect('/workspace', 303);
  }
);
