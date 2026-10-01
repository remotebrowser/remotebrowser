import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import { requireWorkspaceRole, requireSharedWorkspace, requireSubmittedWorkspace } from '../../middleware/workspace.js';
import { getCollaborator, transferOwnership } from '../../models/workspaces.js';
import { getUserByPublicId } from '../../models/users.js';
import { formString } from '../../form.js';
import { renderCollaborators } from './render.js';
import { canTransferOwnership } from './permissions.js';

export const routes = new Hono();

routes.post(
  '/transfer',
  requireUser,
  requireWorkspaceRole('Owner'),
  requireSharedWorkspace,
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(await renderCollaborators(c, { error: 'Your session expired. Please try again.' }), 403);
    }
    const user = c.get('user');
    const workspace = c.get('workspace');
    const targetPublicId = formString(body.publicId);
    if (!canTransferOwnership({ actingUserPublicId: user.publicId, targetPublicId })) {
      return c.html(
        await renderCollaborators(c, { error: 'Choose another collaborator to transfer ownership to.' }),
        400
      );
    }
    const targetUser = await getUserByPublicId({ publicId: targetPublicId });
    if (targetUser.error || !targetUser.data) {
      return c.html(await renderCollaborators(c, { error: 'That collaborator could not be found.' }), 400);
    }
    const targetUserId = targetUser.data.id;
    const target = await getCollaborator({ workspaceId: workspace.id, userId: targetUserId });
    if (target.error || !target.data) {
      return c.html(await renderCollaborators(c, { error: 'That collaborator could not be found.' }), 400);
    }
    const transferred = await transferOwnership({
      workspaceId: workspace.id,
      fromUserId: user.id,
      toUserId: targetUserId
    });
    if (transferred.error) {
      consola.error('transferOwnership failed:', transferred.error);
      return c.html(await renderCollaborators(c, { error: 'Unable to transfer ownership. Please try again.' }), 400);
    }
    return c.redirect('/workspace', 303);
  }
);
