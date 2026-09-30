import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Set before ./config is first required, since config freezes what it read.
process.env.SIGNIN_SENDER_EMAIL = 'login@example.com';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'smtp-user';
process.env.SMTP_PASSWORD = 'smtp-pass';

const { sendMail } = await import('./mailer.js');

const params = { to: 'user@example.com', subject: 'Hello', text: 'plain', html: '<p>rich</p>' };

test('sendMail sends through the configured SMTP server', async (t) => {
  const calls = [];
  mock.method(nodemailer, 'createTransport', (options) => {
    calls.push(options);
    return {
      sendMail: async (message) => {
        calls.push(message);
        return { messageId: 'abc123' };
      }
    };
  });
  t.after(() => mock.restoreAll());

  const result = await sendMail(params);
  assert.deepEqual(result, { data: true });
  assert.deepEqual(calls[0], {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    auth: { user: 'smtp-user', pass: 'smtp-pass' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
  assert.deepEqual(calls[1], {
    from: 'login@example.com',
    to: 'user@example.com',
    subject: 'Hello',
    text: 'plain',
    html: '<p>rich</p>'
  });
});

test('sendMail uses implicit TLS on port 465', () => {
  const script = `
    (async () => {
      const nodemailer = (await import('nodemailer')).default;
      let options;
      nodemailer.createTransport = (value) => {
        options = value;
        return { sendMail: async () => ({}) };
      };
      await require('./mailer').sendMail({ to: 'user@example.com', subject: 's', text: 't', html: 'h' });
      process.stdout.write(String(options.secure));
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, SMTP_PORT: '465' }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /true$/);
});

test('sendMail returns the SMTP error code when the server rejects the message', async (t) => {
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      const error = new Error('Invalid login');
      error.code = 'EAUTH';
      throw error;
    }
  }));
  t.after(() => mock.restoreAll());

  const result = await sendMail(params);
  assert.deepEqual(result, { error: 'EAUTH' });
});

test('sendMail reports an unconfigured SMTP server rather than calling out', () => {
  for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "require('./mailer').sendMail({ to: 'user@example.com', subject: 's', text: 't', html: 'h' }).then((r) => process.stdout.write(r.error))"
      ],
      { cwd: __dirname, env: { ...process.env, [name]: '' } }
    );
    assert.equal(result.status, 0, `expected a clean exit when ${name} is unset`);
    assert.match(result.stdout.toString(), /SMTP is not configured/);
  }
});

test('sendMail reports a missing SIGNIN_SENDER_EMAIL rather than calling out', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "require('./mailer').sendMail({ to: 'user@example.com', subject: 's', text: 't', html: 'h' }).then((r) => process.stdout.write(r.error))"
    ],
    { cwd: __dirname, env: { ...process.env, SIGNIN_SENDER_EMAIL: '' } }
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /SIGNIN_SENDER_EMAIL/);
});
