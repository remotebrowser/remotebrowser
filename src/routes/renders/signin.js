import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';

const renderSignIn = (c, data = {}) =>
  eta.render('signin', {
    error: null,
    csrfToken: createCsrfToken(c),
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    ...data
  });

export { renderSignIn };
