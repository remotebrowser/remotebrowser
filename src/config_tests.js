import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { describe } = test;
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const BASE_ENV = {
  SESSION_SECRET: 'x'.repeat(32),
  RESOURCE_HMAC_SECRET: 'y'.repeat(32),
  PUBLIC_ORIGIN: 'https://example.com',
  SIGNIN_SENDER_EMAIL: 'login@example.com',
  BROWSERFLEET_URL: 'https://browsers.example.com',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'smtp-user',
  SMTP_PASSWORD: 'smtp-pass'
};

const runConfig = (env) =>
  spawnSync(process.execPath, ['-e', "require('./config')"], {
    cwd: __dirname,
    env: { ...process.env, ...BASE_ENV, ...env }
  });

describe('production', () => {
  test('refuses to start without RESOURCE_HMAC_SECRET', () => {
    const result = runConfig({ NODE_ENV: 'production', RESOURCE_HMAC_SECRET: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Missing required environment variable\(s\): RESOURCE_HMAC_SECRET/);
  });

  test('lists each missing variable on its own line, never as a comma-joined list', () => {
    const result = runConfig({ NODE_ENV: 'production', RESOURCE_HMAC_SECRET: '', DATABASE_URL: '' });
    assert.equal(result.status, 1);
    const stderr = result.stderr.toString();
    assert.match(stderr, /Missing required environment variable\(s\): RESOURCE_HMAC_SECRET/);
    assert.match(stderr, /Missing required environment variable\(s\): DATABASE_URL/);
    assert.doesNotMatch(stderr, /RESOURCE_HMAC_SECRET, DATABASE_URL/);
  });

  test('refuses to start when RESOURCE_HMAC_SECRET is under 32 bytes', () => {
    const result = runConfig({ NODE_ENV: 'production', RESOURCE_HMAC_SECRET: 'x'.repeat(31) });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr.toString(),
      /RESOURCE_HMAC_SECRET environment variable of at least 32 bytes is required in production/
    );
  });

  test('starts with a RESOURCE_HMAC_SECRET of exactly 32 bytes', () => {
    const result = runConfig({ NODE_ENV: 'production', RESOURCE_HMAC_SECRET: 'x'.repeat(32) });
    assert.equal(result.status, 0);
  });

  test('refuses to start without SESSION_SECRET', () => {
    const result = runConfig({ NODE_ENV: 'production', SESSION_SECRET: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Missing required environment variable\(s\): SESSION_SECRET/);
  });

  test('refuses to start with a blank SESSION_SECRET', () => {
    const result = runConfig({ NODE_ENV: 'production', SESSION_SECRET: '   ' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /SESSION_SECRET environment variable is required in production/);
  });

  test('refuses to start when SESSION_SECRET is under 32 bytes', () => {
    const result = runConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(31) });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr.toString(),
      /SESSION_SECRET environment variable of at least 32 bytes is required in production/
    );
  });

  test('starts with a SESSION_SECRET of exactly 32 bytes', () => {
    const result = runConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) });
    assert.equal(result.status, 0);
  });

  test('starts with a comma-separated pair of SESSION_SECRETs, each at least 32 bytes', () => {
    const result = runConfig({ NODE_ENV: 'production', SESSION_SECRET: `${'x'.repeat(32)},${'y'.repeat(32)}` });
    assert.equal(result.status, 0);
  });

  test('refuses to start when the second SESSION_SECRET is under 32 bytes', () => {
    const result = runConfig({ NODE_ENV: 'production', SESSION_SECRET: `${'x'.repeat(32)},${'y'.repeat(31)}` });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr.toString(),
      /SESSION_SECRET environment variable of at least 32 bytes is required in production/
    );
  });

  test('refuses to start without SIGNIN_SENDER_EMAIL, since no mail could be sent', () => {
    const result = runConfig({ NODE_ENV: 'production', SIGNIN_SENDER_EMAIL: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Missing required environment variable\(s\): SIGNIN_SENDER_EMAIL/);
  });

  test('refuses to start without PUBLIC_ORIGIN, since email links would fall back to the Host header', () => {
    const result = runConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Missing required environment variable\(s\): PUBLIC_ORIGIN/);
  });

  test('refuses to start when PUBLIC_ORIGIN is not a bare https origin', () => {
    for (const value of ['http://example.com', 'https://example.com/app', 'example.com', 'https://example.com?a=1']) {
      const result = runConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: value });
      assert.equal(result.status, 1, `expected ${value} to be rejected`);
      assert.match(result.stderr.toString(), /PUBLIC_ORIGIN must be an https origin/);
    }
  });

  test('refuses to start without DATABASE_URL', () => {
    const result = runConfig({ NODE_ENV: 'production', DATABASE_URL: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Missing required environment variable\(s\): DATABASE_URL/);
  });

  test('refuses to start when DATABASE_URL is not a postgres connection string', () => {
    const result = runConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://user:pass@localhost/db' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /DATABASE_URL must be a postgres connection string/);
  });

  test('starts with a postgres:// or postgresql:// DATABASE_URL', () => {
    for (const url of ['postgres://user:pass@localhost:5432/db', 'postgresql://user:pass@localhost:5432/db']) {
      const result = runConfig({ NODE_ENV: 'production', DATABASE_URL: url });
      assert.equal(result.status, 0, `expected ${url} to be accepted`);
    }
  });

  test('refuses to start without SMTP credentials, since no email could be sent', () => {
    for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
      const result = runConfig({ NODE_ENV: 'production', [name]: '' });
      assert.equal(result.status, 1, `expected a refusal when ${name} is unset`);
      assert.match(result.stderr.toString(), new RegExp(`Missing required environment variable\\(s\\): ${name}`));
    }
  });

  test('refuses to start with an invalid SMTP_PORT', () => {
    for (const value of ['abc', '0', '70000']) {
      const result = runConfig({ NODE_ENV: 'production', SMTP_PORT: value });
      assert.equal(result.status, 1, `expected ${value} to be rejected`);
      assert.match(result.stderr.toString(), /SMTP_PORT must be a port number/);
    }
  });
});

describe('development', () => {
  test('allows a custom PGlite data directory', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(require('./config').config.pgliteDataDir)"],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, PGLITE_DATA_DIR: '/tmp/remotebrowser-pglite' } }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), '/tmp/remotebrowser-pglite');
  });
});

describe('sessionSecret', () => {
  const readSessionSecrets = (env) => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const c = require('./config').config; process.stdout.write(JSON.stringify([c.sessionSecret.toString(), c.previousSessionSecret && c.previousSessionSecret.toString()]))"
      ],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout.toString());
  };

  test('uses a dummy secret and no previous secret when SESSION_SECRET is unset', () => {
    assert.deepEqual(readSessionSecrets({ SESSION_SECRET: '' }), ['dummy-session-secret', null]);
  });

  test('uses the first secret and null when there is no previous secret', () => {
    assert.deepEqual(readSessionSecrets({ SESSION_SECRET: 'alpha' }), ['alpha', null]);
  });

  test('uses the first secret as sessionSecret and the second as previousSessionSecret', () => {
    assert.deepEqual(readSessionSecrets({ SESSION_SECRET: 'alpha,beta' }), ['alpha', 'beta']);
  });

  test('trims whitespace around each secret', () => {
    assert.deepEqual(readSessionSecrets({ SESSION_SECRET: '  alpha , beta  ' }), ['alpha', 'beta']);
  });

  test('ignores empty entries within the list', () => {
    assert.deepEqual(readSessionSecrets({ SESSION_SECRET: 'alpha,,,beta' }), ['alpha', 'beta']);
  });

  test('ignores secrets beyond the first two', () => {
    assert.deepEqual(readSessionSecrets({ SESSION_SECRET: 'alpha,beta,gamma' }), ['alpha', 'beta']);
  });
});

describe('browserFleetUrl', () => {
  const readBrowserFleetUrl = (env) => {
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./config').config.browserFleetUrl))"],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    assert.equal(result.status, 0);
    return result.stdout.toString().trim();
  };

  test('refuses to start in production without BROWSERFLEET_URL, since no browser could be provisioned', () => {
    const result = runConfig({ NODE_ENV: 'production', BROWSERFLEET_URL: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Missing required environment variable\(s\): BROWSERFLEET_URL/);
  });

  test('trims trailing slashes so the appended API path is not doubled', () => {
    assert.equal(
      readBrowserFleetUrl({ BROWSERFLEET_URL: 'https://browsers.example.com//' }),
      'https://browsers.example.com'
    );
  });

  test('is null outside production when unset', () => {
    assert.equal(readBrowserFleetUrl({ NODE_ENV: 'development', BROWSERFLEET_URL: '' }), 'null');
  });
});

describe('databaseUrl', () => {
  const readDatabase = (env) => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const c = require('./config').config; process.stdout.write(JSON.stringify([c.databaseUrl, c.databaseSsl || null]))"
      ],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout.toString());
  };

  test('is null outside production when unset', () => {
    assert.deepEqual(readDatabase({ NODE_ENV: 'development', DATABASE_URL: '' }), [null, null]);
  });

  test('defaults to a relaxed TLS check in production, since most hosts use a managed certificate', () => {
    const [, ssl] = readDatabase({ NODE_ENV: 'production' });
    assert.deepEqual(ssl, { rejectUnauthorized: false });
  });

  test('skips TLS when DATABASE_SSL_MODE=disable', () => {
    const [, ssl] = readDatabase({ NODE_ENV: 'production', DATABASE_SSL_MODE: 'disable' });
    assert.equal(ssl, null);
  });
});

describe('signinSenderEmail', () => {
  const readSigninSenderEmail = (env) => {
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./config').config.signinSenderEmail))"],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    assert.equal(result.status, 0);
    return result.stdout.toString().trim();
  };

  test('uses SIGNIN_SENDER_EMAIL verbatim, independent of PUBLIC_ORIGIN', () => {
    assert.equal(
      readSigninSenderEmail({ PUBLIC_ORIGIN: 'https://example.com', SIGNIN_SENDER_EMAIL: 'login@mail.example.net' }),
      'login@mail.example.net'
    );
  });

  test('is null outside production when SIGNIN_SENDER_EMAIL is unset', () => {
    assert.equal(readSigninSenderEmail({ NODE_ENV: 'development', SIGNIN_SENDER_EMAIL: '' }), 'null');
  });
});

describe('smtp', () => {
  const readSmtp = (env) => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const c = require('./config').config; process.stdout.write(JSON.stringify([c.smtpHost, c.smtpPort, c.smtpUser, c.mailConfigured]))"
      ],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout.toString());
  };

  test('reads the host, user, and password from the environment', () => {
    assert.deepEqual(readSmtp({ SMTP_HOST: 'mail.example.net', SMTP_USER: 'bot', SMTP_PASSWORD: 'secret' }), [
      'mail.example.net',
      587,
      'bot',
      true
    ]);
  });

  test('honors SMTP_PORT when set', () => {
    assert.equal(readSmtp({ SMTP_PORT: '465' })[1], 465);
  });

  test('is not configured outside production when the SMTP settings are unset', () => {
    assert.deepEqual(readSmtp({ NODE_ENV: 'development', SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '' }), [
      null,
      587,
      null,
      false
    ]);
  });
});

describe('browser capacity limits', () => {
  const readLimits = (env) => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const c = require('./config').config; process.stdout.write(JSON.stringify([c.maxPersonalBrowsers, c.maxTeamBrowsers]))"
      ],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout.toString());
  };

  test('defaults to 3 personal and 10 team browsers when unset', () => {
    assert.deepEqual(readLimits({ MAX_PERSONAL_BROWSERS: '', MAX_TEAM_BROWSERS: '' }), [3, 10]);
  });

  test('honors MAX_PERSONAL_BROWSERS and MAX_TEAM_BROWSERS when set', () => {
    assert.deepEqual(readLimits({ MAX_PERSONAL_BROWSERS: '5', MAX_TEAM_BROWSERS: '25' }), [5, 25]);
  });
});

describe('trustedProxyHops', () => {
  const readHops = (env) => {
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./config').config.trustedProxyHops))"],
      { cwd: __dirname, env: { ...process.env, ...BASE_ENV, ...env } }
    );
    return { status: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  // Trusting X-Forwarded-For must be opt-in, or any client could pick its own address.
  test('defaults to 0 when unset', () => {
    assert.equal(readHops({ TRUSTED_PROXY_HOPS: '' }).stdout, '0');
  });

  test('honors TRUSTED_PROXY_HOPS when set', () => {
    assert.equal(readHops({ TRUSTED_PROXY_HOPS: '1' }).stdout, '1');
  });

  test('refuses to start with an invalid TRUSTED_PROXY_HOPS', () => {
    for (const value of ['abc', '-1', '1.5']) {
      const result = readHops({ TRUSTED_PROXY_HOPS: value });
      assert.equal(result.status, 1, `expected ${value} to be rejected`);
      assert.match(result.stderr, /TRUSTED_PROXY_HOPS must be a non-negative integer/);
    }
  });
});
