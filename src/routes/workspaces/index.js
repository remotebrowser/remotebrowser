import { Hono } from 'hono';
import { requireUser } from '../../middleware/auth.js';
import { renderWorkspaces } from './render.js';

export const routes = new Hono();

routes.get('/', requireUser, async (c) => c.html(await renderWorkspaces(c)));
