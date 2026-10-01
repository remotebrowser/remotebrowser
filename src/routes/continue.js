import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../render.js';
import { createCsrfToken, verifyCsrfToken, rotateCsrfId } from '../auth/csrf.js';
import { signInWithEmailLink } from '../auth/magic.js';
import { readSigninEmailCookie, clearSigninEmailCookie, setSessionCookie } from '../auth/session.js';
import { requireGuest } from '../middleware/auth.js';
import { findOrCreateUser } from '../models/users.js';
import { claimInvitationsForUser, ensurePersonalWorkspace } from '../models/workspaces.js';
import { formString } from '../form.js';
import { isEmailAddress } from '../email.js';

export const routes = new Hono();

const renderContinue = (c, data = {}) =>
  eta.render('continue', {
    error: null,
    // A dead link cannot be retried with the same nonce, so the form is
    // replaced by a link back to /signin for a fresh one.
    linkInvalid: false,
    csrfToken: createCsrfToken(c),
    nonce: '',
    email: '',
    ...data
  });

routes.get('/', requireGuest, async (c) =>
  c.html(renderContinue(c, { nonce: c.req.query('nonce') || '', email: readSigninEmailCookie(c) || '' }))
);

routes.post('/', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(
      renderContinue(c, {
        nonce: formString(body.nonce),
        email: formString(body.email),
        error: 'Your session expired. Please try again.'
      }),
      403
    );
  }
  const email = formString(body.email).trim().toLowerCase();
  const nonce = formString(body.nonce);
  if (!isEmailAddress(email) || !nonce) {
    return c.html(
      renderContinue(c, { nonce, email, linkInvalid: true, error: 'The sign-in link is invalid or has expired.' }),
      400
    );
  }
  const verified = await signInWithEmailLink(email, nonce);
  if (verified.error) {
    consola.error('signInWithEmailLink failed:', verified.error);
    return c.html(
      renderContinue(c, { nonce, email, linkInvalid: true, error: 'The sign-in link is invalid or has expired.' }),
      401
    );
  }
  const claimEmail = verified.data.email;
  const user = await findOrCreateUser({ email: claimEmail });
  if (user.error) {
    consola.error('findOrCreateUser failed:', user.error);
    return c.html(renderContinue(c, { nonce, email, error: 'Unable to sign you in. Please try again.' }), 500);
  }
  const { id, publicId, isNewUser } = user.data;
  // New users get a workspace here; a failure retries on the next page view.
  if (isNewUser) {
    const workspace = await ensurePersonalWorkspace({
      userId: id,
      email: claimEmail,
      personalWorkspaceId: null
    });
    if (workspace.error) {
      consola.error('ensurePersonalWorkspace failed:', workspace.error);
    }
  }
  const claimResult = await claimInvitationsForUser({ userId: id, email: claimEmail });
  if (claimResult.error) {
    consola.error('claimInvitationsForUser (listInvitationsByEmail) failed:', claimResult.error);
  } else {
    for (const failure of claimResult.data.failed) {
      consola.error(`claimInvitationsForUser (${failure.step}) failed:`, failure.error);
    }
  }
  clearSigninEmailCookie(c);
  // CSRF token was for anonymous visitor; rotate before auth session.
  rotateCsrfId(c);
  setSessionCookie(c, { publicId, email: claimEmail, issuedAt: Date.now() });
  consola.info('SIGNIN', { 'event.domain': 'user', 'user.id': id, 'user.email': claimEmail });
  return c.redirect('/', 303);
});
