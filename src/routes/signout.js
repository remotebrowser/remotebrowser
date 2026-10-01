import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { verifyCsrfToken, rotateCsrfId } from '../auth/csrf.js';
import { clearSessionCookie } from '../auth/session.js';
import { currentUser } from '../middleware/auth.js';
import { revokeSessions } from '../models/users.js';

export const routes = new Hono();

routes.post('/', async (c) => {
  const body = await c.req.parseBody();
  // Failed check must not redirect like success; no-op would look identical.
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.text('Forbidden', 403);
  }
  // Resolved directly (not via requireUser); signed-out lands on / not /signin.
  const user = await currentUser(c);
  if (user) {
    // Cookie ends this session; marker invalidates all others (captured too).
    const revoked = await revokeSessions({ id: user.id });
    if (revoked.error) {
      consola.error('revokeSessions failed:', revoked.error);
    }
    consola.info('SIGNOUT', { 'event.domain': 'user', 'user.id': user.id, 'user.email': user.email });
  }
  clearSessionCookie(c);
  rotateCsrfId(c);
  return c.redirect('/', 303);
});
