import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consola } from 'consola/basic';
import { parseSecrets } from './secret.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const buildConfig = (env) => {
  const errors = [];
  const isProduction = env.NODE_ENV === 'production';
  const secureCookies = isProduction || env.SECURE_COOKIES === 'true';
  if (isProduction && env.SECURE_COOKIES === 'false') {
    errors.push('SECURE_COOKIES cannot be false when NODE_ENV=production');
  }

  const REQUIRED_ENV_VARS = [
    'SESSION_SECRET',
    'RESOURCE_HMAC_SECRET',
    'PUBLIC_ORIGIN',
    'SIGNIN_SENDER_EMAIL',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'BROWSERFLEET_URL',
    'DATABASE_URL'
  ];

  if (isProduction) {
    for (const name of REQUIRED_ENV_VARS) {
      if (!env[name]) {
        errors.push(`Missing required environment variable(s): ${name}`);
      }
    }
  }

  // Single secret or comma-separated pair (primary + rotation for decrypt only).
  const SESSION_SECRET_MIN_BYTES = 32;
  const sessionSecrets = parseSecrets(env.SESSION_SECRET);

  if (isProduction && env.SESSION_SECRET && sessionSecrets.length === 0) {
    errors.push('SESSION_SECRET environment variable is required in production');
  }

  if (isProduction && sessionSecrets.some((secret) => Buffer.byteLength(secret) < SESSION_SECRET_MIN_BYTES)) {
    errors.push(
      `SESSION_SECRET environment variable of at least ${SESSION_SECRET_MIN_BYTES} bytes is required in production`
    );
  }

  // Separate from SESSION_SECRET: handle MAC must not be forgeable via cookie leak.
  if (
    isProduction &&
    env.RESOURCE_HMAC_SECRET &&
    Buffer.byteLength(env.RESOURCE_HMAC_SECRET) < SESSION_SECRET_MIN_BYTES
  ) {
    errors.push(
      `RESOURCE_HMAC_SECRET environment variable of at least ${SESSION_SECRET_MIN_BYTES} bytes is required in production`
    );
  }

  // The sign-in link's continueUrl must not come from the request (a forged Host
  // would redirect a real nonce to an attacker). Production pins it here.
  const PUBLIC_ORIGIN = env.PUBLIC_ORIGIN;
  if (isProduction && PUBLIC_ORIGIN && !/^https:\/\/[^/?#\s]+$/.test(PUBLIC_ORIGIN)) {
    errors.push(`PUBLIC_ORIGIN must be an https origin with no trailing path, e.g. https://example.com`);
  }

  // SMTP over implicit TLS (465) or STARTTLS (587 and others); the port only
  // has to be sane, mailer.js picks the TLS mode from it.
  const smtpPort = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
  if (env.SMTP_PORT && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    errors.push('SMTP_PORT must be a port number between 1 and 65535, e.g. 587');
  }

  // A bare postgres connection string; DB access never goes through an emulator.
  const DATABASE_URL = env.DATABASE_URL;
  if (DATABASE_URL && !/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
    errors.push('DATABASE_URL must be a postgres connection string, e.g. postgres://user:password@host:5432/dbname');
  }

  // Fleet origin; src/fleet.js appends API path so trailing slash must not double.
  const BROWSERFLEET_URL = (env.BROWSERFLEET_URL || '').replace(/\/+$/, '');

  // Max browsers per workspace; personal for one user, shared pools across team.
  const MAX_PERSONAL_BROWSERS = Number(env.MAX_PERSONAL_BROWSERS) || 3;
  const MAX_TEAM_BROWSERS = Number(env.MAX_TEAM_BROWSERS) || 10;

  // Reverse proxies in front of the app, e.g. nginx, a load balancer, or a CDN.
  // X-Forwarded-For is client-controlled, so only this many entries from the
  // right are trusted.
  const trustedProxyHops = env.TRUSTED_PROXY_HOPS ? Number(env.TRUSTED_PROXY_HOPS) : 0;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) {
    errors.push('TRUSTED_PROXY_HOPS must be a non-negative integer, e.g. 1 behind a single reverse proxy');
  }

  const publicOrigin = PUBLIC_ORIGIN || null;
  // The full sender address, e.g. login@example.com. It is configured rather
  // than derived from PUBLIC_ORIGIN, since the sending domain may differ from
  // the one users browse. Providers require it to be a verified sender.
  const signinSenderEmail = env.SIGNIN_SENDER_EMAIL || null;
  const smtpHost = env.SMTP_HOST || null;
  const smtpUser = env.SMTP_USER || null;
  const smtpPassword = env.SMTP_PASSWORD || null;
  // Sign-in links fall back to the server console unless a full SMTP
  // transport is configured.
  const mailConfigured = Boolean(smtpHost && smtpUser && smtpPassword);
  const sessionSecret = Buffer.from(sessionSecrets[0] || 'dummy-session-secret');
  const previousSessionSecret = sessionSecrets[1] ? Buffer.from(sessionSecrets[1]) : null;
  const resourceHmacSecret = Buffer.from(env.RESOURCE_HMAC_SECRET || 'dummy-resource-hmac-secret');
  const sessionNotBefore = Number(env.SESSION_NOT_BEFORE || 0);
  const sessionTtlSeconds = 7 * 60 * 60;
  const browserFleetUrl = BROWSERFLEET_URL || null;
  // Local dev/test only, when DATABASE_URL is unset; PGlite is not installed in production.
  const pgliteDataDir = env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.data', 'pglite');
  const databaseUrl = DATABASE_URL || null;
  // Most managed Postgres hosts terminate TLS with a managed (not publicly
  // trusted) certificate; DATABASE_SSL_MODE=disable opts back out.
  const databaseSsl =
    databaseUrl && isProduction && env.DATABASE_SSL_MODE !== 'disable' ? { rejectUnauthorized: false } : undefined;

  const config = Object.freeze({
    isProduction,
    secureCookies,
    port: Number(env.PORT) || 3000,
    viewsDir: path.join(__dirname, '..', 'views'),
    publicOrigin,
    sessionSecret,
    previousSessionSecret,
    resourceHmacSecret,
    sessionNotBefore,
    sessionTtlSeconds,
    browserFleetUrl,
    pgliteDataDir,
    databaseUrl,
    databaseSsl,
    signinSenderEmail,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPassword,
    mailConfigured,
    maxPersonalBrowsers: MAX_PERSONAL_BROWSERS,
    maxTeamBrowsers: MAX_TEAM_BROWSERS,
    trustedProxyHops
  });

  return { config, errors };
};

const { config, errors } = buildConfig(process.env);
if (errors.length > 0) {
  for (const message of errors) consola.error(message);
  process.exit(1);
}

export { buildConfig, config };
