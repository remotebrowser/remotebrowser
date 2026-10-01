import { Hono } from 'hono';
import { verifyCsrfToken } from '../../auth/csrf.js';
import { setActiveWorkspace } from '../../auth/session.js';
import { requireUser } from '../../middleware/auth.js';
import { getCollaborator } from '../../models/workspaces.js';
import { formString } from '../../form.js';
import { renderWorkspaces } from './render.js';

export const routes = new Hono();

// Changes the active workspace only here, checking collaborator status first.
routes.post('/switch', requireUser, async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(await renderWorkspaces(c, { error: 'Your session expired. Please try again.' }), 403);
  }
  const workspaceId = Number(formString(body.workspace));
  const user = c.get('user');
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    return c.html(await renderWorkspaces(c, { error: 'Choose a workspace to switch to.' }), 400);
  }
  if (workspaceId !== user.personalWorkspaceId) {
    const collaborator = await getCollaborator({ workspaceId, userId: user.id });
    if (collaborator.error || !collaborator.data) {
      return c.html(await renderWorkspaces(c, { error: 'You are not a collaborator of that workspace.' }), 403);
    }
  }
  setActiveWorkspace(c, workspaceId);
  return c.redirect('/', 303);
});
