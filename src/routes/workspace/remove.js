import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  hasRole
} from '../../middleware/workspace.js';
import { getCollaborator, deleteCollaborator } from '../../models/workspaces.js';
import { getUserByPublicId } from '../../models/users.js';
import { renderCollaborators } from './render.js';
import { outranks } from './permissions.js';

export const routes = new Hono();

routes.post(
  '/:publicId/remove',
  requireUser,
  requireWorkspaceRole('User'),
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(await renderCollaborators(c, { error: 'Your session expired. Please try again.' }), 403);
    }
    const user = c.get('user');
    const workspace = c.get('workspace');
    const targetUser = await getUserByPublicId({ publicId: c.req.param('publicId') });
    if (targetUser.error || !targetUser.data) {
      return c.html(await renderCollaborators(c, { error: 'That collaborator could not be found.' }), 400);
    }
    const targetUserId = targetUser.data.id;
    const isSelf = targetUserId === user.id;
    const target = await getCollaborator({ workspaceId: workspace.id, userId: targetUserId });
    if (target.error || !target.data) {
      return c.html(await renderCollaborators(c, { error: 'That collaborator could not be found.' }), 400);
    }
    if (target.data.role === 'Owner') {
      return c.html(
        await renderCollaborators(c, {
          error: isSelf
            ? 'Transfer ownership before leaving the workspace.'
            : 'The Owner must transfer ownership before being removed.'
        }),
        400
      );
    }
    if (!isSelf) {
      if (!hasRole(workspace.role, 'Admin')) {
        return c.html(
          await renderCollaborators(c, { error: 'Only an Admin or Owner can remove other collaborators.' }),
          403
        );
      }
      if (!outranks({ actingRole: workspace.role, targetRole: target.data.role })) {
        return c.html(
          await renderCollaborators(c, { error: 'You cannot remove a collaborator at or above your own rank.' }),
          403
        );
      }
    }
    const removed = await deleteCollaborator({
      workspaceId: workspace.id,
      userId: targetUserId
    });
    if (removed.error) {
      consola.error('deleteCollaborator failed:', removed.error);
      return c.html(
        await renderCollaborators(c, { error: 'Unable to remove the collaborator. Please try again.' }),
        400
      );
    }
    if (isSelf) {
      return c.redirect('/workspaces', 303);
    }
    return c.redirect('/workspace', 303);
  }
);
