import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../render.js';
import { verifyCsrfToken } from '../auth/csrf.js';
import { sendSignInLink } from '../auth/magic.js';
import { createSigninEmailCookie } from '../auth/session.js';
import { formString } from '../form.js';
import { isEmailAddress } from '../email.js';
import { absoluteOrigin } from '../origin.js';
import { renderSignIn } from './renders/signin.js';

export const routes = new Hono();

routes.post('/', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(renderSignIn(c, { error: 'Your session expired. Please try again.' }), 403);
  }
  const email = formString(body.email).trim();
  if (!isEmailAddress(email)) {
    return c.html(renderSignIn(c, { error: 'A valid email address is required.' }), 400);
  }
  const continueUrl = `${absoluteOrigin(c)}/continue`;
  const normalizedEmail = email.toLowerCase();
  consola.start('Preparing sign-in link');
  const result = await sendSignInLink(normalizedEmail, continueUrl);
  if (result.error) {
    consola.error('sendSignInLink failed:', result.error);
    return c.html(renderSignIn(c, { error: 'Unable to send the sign-in link. Please try again.' }), 400);
  }
  consola.info('INIT_MAGIC_LINK', { 'event.domain': 'user', 'user.email': normalizedEmail });
  createSigninEmailCookie(c, normalizedEmail);
  return c.html(eta.render('sent', { email: normalizedEmail, emailSent: result.data.delivered }));
});
