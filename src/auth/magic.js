import { consola } from 'consola/basic';
import { config } from '../config.js';
import { createNonce, parseNonce } from './nonce.js';
import { recordSigninCode, consumeSigninCode } from '../models/users.js';
import { sendMail } from '../mailer.js';
import { eta } from '../render.js';

// Without a mail transport (a configured SMTP server) there is no way to
// deliver sign-in links, so they are printed to the server console instead.
// The latest code per email is remembered so the dev-only route (and the
// e2e suite) can read it back.
const devCodes = new Map();

const sendSignInLink = async (email, continueUrl) => {
  const normalized = email.toLowerCase();
  const { token, expires, nonce } = createNonce(normalized);
  const stored = await recordSigninCode({ token, email: normalized, expires });
  if (stored.error) {
    consola.error('recordSigninCode failed:', stored.error);
    return { error: stored.error };
  }
  const link = `${continueUrl}?nonce=${nonce}`;
  const delivered = config.mailConfigured;
  if (delivered) {
    const sent = await sendMail({
      to: normalized,
      subject: 'Sign in to Remote Browser',
      text: `Click below to sign in to your Remote Browser account (valid for 5 minutes):\n\n${link}\n\nDidn't request this? Safely ignore this email.`,
      html: eta.render('email/signin', { link })
    });
    if (sent.error) {
      return { error: sent.error };
    }
  } else {
    devCodes.set(normalized, nonce);
    consola.info(`To sign in as ${normalized}, follow this link: ${link}`);
  }
  return { data: { link, delivered } };
};

const signInWithEmailLink = async (email, nonce) => {
  const normalized = email.toLowerCase();
  const parsed = parseNonce(normalized, nonce);
  if (!parsed) return { error: 'INVALID_NONCE' };
  const consumed = await consumeSigninCode({ token: parsed.token, email: normalized });
  if (consumed.error) return { error: consumed.error };
  return { data: { email: consumed.data.email } };
};

const latestSignInCode = (email) => devCodes.get(email.toLowerCase()) || null;

export { sendSignInLink, signInWithEmailLink, latestSignInCode };
