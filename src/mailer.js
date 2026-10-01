import nodemailer from 'nodemailer';
import { consola } from 'consola/basic';
import { config } from './config.js';

// Mail servers can be slow under load; bound every step of the SMTP
// conversation the same way fleet.js bounds its HTTP calls.
const EMAIL_TIMEOUT = 10000;

/**
 * Builds an SMTP transport for the configured server. Port 465 expects TLS
 * from the first byte; every other port upgrades with STARTTLS when offered.
 * The transport is built per send, so a restarted server is picked up and the
 * password never lives in a long-lived object.
 */
const smtpTransport = () =>
  nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword
    },
    connectionTimeout: EMAIL_TIMEOUT,
    greetingTimeout: EMAIL_TIMEOUT,
    socketTimeout: EMAIL_TIMEOUT
  });

/**
 * Sends an email through the configured SMTP server.
 * @param {{to: string, subject: string, text: string, html: string}} params
 * @returns {Promise<{data?: true, error?: string}>}
 */
const sendMail = async ({ to, subject, text, html }) => {
  if (!config.signinSenderEmail) {
    return { error: 'SIGNIN_SENDER_EMAIL is not configured' };
  }
  if (!config.mailConfigured) {
    return { error: 'SMTP is not configured' };
  }
  try {
    await smtpTransport().sendMail({
      from: config.signinSenderEmail,
      to,
      subject,
      text,
      html
    });
  } catch (error) {
    // Nodemailer tags failures with a code such as EAUTH or ECONNECTION;
    // without it a rejected send is undebuggable.
    const code = error?.code || 'SEND_FAILED';
    consola.error('SMTP_EMAIL_FAILED', {
      'event.domain': 'user',
      'user.email': to,
      'error.type': code,
      'error.message': error?.message ? String(error.message).slice(0, 300) : undefined,
      'email.from': config.signinSenderEmail
    });
    return { error: code };
  }
  consola.info('SMTP_EMAIL_SENT', { 'event.domain': 'user', 'user.email': to });
  return { data: true };
};

export { sendMail };
