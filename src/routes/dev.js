import { Hono } from 'hono';
import { config } from '../config.js';
import { latestSignInCode } from '../auth/magic.js';

export const routes = new Hono();

// Non-production only. It lets the e2e suite read back the most recent
// sign-in nonce, which is otherwise only printed to the server console.
if (!config.isProduction) {
  routes.get('/nonces', (c) => {
    const email = c.req.query('email');
    const nonce = email ? latestSignInCode(email) : null;
    if (!nonce) return c.json({ nonce: null }, 404);
    return c.json({ nonce });
  });
}
