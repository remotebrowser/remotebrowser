import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { absoluteOrigin } from '../../origin.js';
import { formatUserCode, isWellFormedCliToken } from '../../cli.js';
import {
  createDeviceAuthorization,
  pollDeviceAuthorization,
  deleteCliSessionByToken,
  DEVICE_CODE_TTL_MS,
  POLL_INTERVAL_SECONDS
} from '../../models/cli.js';
import { recheckApiSessions } from './sessions.js';

// The CLI login, the OAuth 2.0 Device Authorization Grant (RFC 8628). The CLI
// starts a login, the user approves it on /activate, and the CLI polls for
// the token. Never log a device code or a token.

export const routes = new Hono();

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// The CLI sends JSON; a form body is accepted too, as RFC 8628 uses one.
const readBody = async (c) => {
  const type = c.req.header('Content-Type') || '';
  try {
    if (type.includes('application/json')) {
      const body = await c.req.json();
      return body && typeof body === 'object' ? body : {};
    }
    return await c.req.parseBody();
  } catch {
    return {};
  }
};

routes.post('/device', async (c) => {
  const ipAddress = c.get('ipAddress') ?? null;
  const body = await readBody(c);
  // body.days is accepted but not used yet: every login lasts CLI_SESSION_DAYS.
  const created = await createDeviceAuthorization({
    deviceName: body.device_name,
    ipAddress,
    userAgent: c.req.header('User-Agent')
  });
  if (created.error === 'DEVICE_RATE_LIMITED') {
    c.header('Retry-After', '600');
    return c.json({ error: 'Too many login attempts. Please try again in 10 minutes.' }, 429);
  }
  if (created.error) {
    consola.error('AUTH could not start a CLI login', { 'event.domain': 'auth', 'error.type': String(created.error) });
    return c.json({ error: 'Unable to start the login. Please try again.' }, 503);
  }
  // From PUBLIC_ORIGIN in production, so a fake Host header cannot send the user to another site.
  const verificationUri = `${absoluteOrigin(c)}/activate`;
  const userCode = formatUserCode(created.data.userCode);
  return c.json({
    device_code: created.data.deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?code=${userCode}`,
    expires_in: Math.round(DEVICE_CODE_TTL_MS / 1000),
    interval: POLL_INTERVAL_SECONDS
  });
});

// Every result except success is a 400 with an OAuth error code, because the
// CLI retries a 5xx, and everywhere else a 401 means a bad token.
const POLL_ERRORS = {
  pending: 'authorization_pending',
  slow_down: 'slow_down',
  denied: 'access_denied',
  expired: 'expired_token'
};

routes.post('/token', async (c) => {
  const body = await readBody(c);
  if (body.grant_type !== DEVICE_CODE_GRANT) {
    return c.json({ error: 'unsupported_grant_type' }, 400);
  }
  const polled = await pollDeviceAuthorization({ deviceCode: body.device_code });
  if (polled.error) {
    consola.error('AUTH could not check a CLI login', { 'event.domain': 'auth', 'error.type': String(polled.error) });
    return c.json({ error: 'Unable to check the login. Please try again.' }, 503);
  }
  const { status } = polled.data;
  if (status !== 'issued') return c.json({ error: POLL_ERRORS[status] }, 400);
  const { session } = polled.data;
  consola.info('CLI session created', {
    'event.domain': 'auth',
    'user.id': session.creatorUserId,
    'workspace.id': session.workspaceId,
    'rb.cli_session': session.publicId
  });
  return c.json({ access_token: polled.data.token, token_type: 'Bearer', expires_in: polled.data.expiresIn });
});

const BEARER_PATTERN = /^Bearer +(\S+) *$/i;

// 'remotebrowser logout': the token revokes itself, even when expired.
routes.post('/revoke', async (c) => {
  const match = BEARER_PATTERN.exec(c.req.header('Authorization') || '');
  if (!match || !isWellFormedCliToken(match[1])) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'A valid CLI token is required.' }, 401);
  }
  const deleted = await deleteCliSessionByToken({ token: match[1] });
  if (deleted.error) {
    consola.error('AUTH could not revoke a CLI session', {
      'event.domain': 'auth',
      'error.type': String(deleted.error)
    });
    return c.json({ error: 'Unable to log out. Please try again.' }, 503);
  }
  if (!deleted.data) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'A valid CLI token is required.' }, 401);
  }
  // End the CDP sessions the token opened now, not at the next periodic check.
  recheckApiSessions();
  return c.body(null, 204);
});
