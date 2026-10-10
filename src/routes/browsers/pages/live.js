import { Hono } from 'hono';
import { requireUser } from '../../../middleware/auth.js';
import { requireWorkspaceRole } from '../../../middleware/workspace.js';
import { renderPage } from './show.js';

export const routes = new Hono();

// Loaded by htmx, so the page still shows a static screenshot without JavaScript.
routes.get('/:browserId/pages/:pageId/live', requireUser, requireWorkspaceRole('User'), async (c) => {
  const html = await renderPage(c, 'browsers/pages/screencast');
  return html ? c.html(html) : c.text('Not found', 404);
});
