import { Hono } from 'hono';
import { currentUser } from '../middleware/auth.js';
import { renderSignIn } from './renders/signin.js';

export const routes = new Hono();

routes.get('/', async (c) => {
  const user = await currentUser(c);
  if (user) return c.redirect('/', 303);
  return c.html(renderSignIn(c));
});
