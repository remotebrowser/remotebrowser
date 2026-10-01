import { Hono } from 'hono';
import { requireUser } from '../../middleware/auth.js';
import { requireWorkspaceRole, requireSharedWorkspace } from '../../middleware/workspace.js';
import { renderCollaborators } from './render.js';

export const routes = new Hono();

routes.get('/', requireUser, requireWorkspaceRole('User'), requireSharedWorkspace, async (c) =>
  c.html(await renderCollaborators(c))
);
