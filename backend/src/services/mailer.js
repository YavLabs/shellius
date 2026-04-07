/**
 * mailer.js
 *
 * Thin nodemailer wrapper with lazy transport initialization.
 * Reads SMTP config from environment variables. When SMTP_HOST is not set
 * the transport falls back to "log" mode: the email body is emitted via
 * the structured logger and the raw URL (if any) is returned to the caller
 * so an admin can copy-paste it manually.
 *
 * Exported:
 *   sendMail({ to, subject, html, text }) → { delivered: bool, transport: 'smtp'|'log' }
 */

import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

let _transport = null;
let _from = null;
let _transportType = null;

function initTransport() {
  if (_transport !== null) return;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const defaultFrom =
    process.env.SMTP_FROM ??
    `noreply@${process.env.TRAEFIK_HOST ?? 'shellius.local'}`;

  _from = defaultFrom;

  if (!host) {
    _transportType = 'log';
    _transport = null; // Sentinel: no real transport
    return;
  }

  _transportType = 'smtp';
  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

/**
 * Send an email (or log it when SMTP is not configured).
 *
 * @param {object} params
 * @param {string}  params.to       - Recipient address
 * @param {string}  params.subject  - Email subject
 * @param {string}  [params.html]   - HTML body
 * @param {string}  [params.text]   - Plain-text body
 * @returns {Promise<{ delivered: boolean, transport: 'smtp'|'log' }>}
 */
export async function sendMail({ to, subject, html, text }) {
  initTransport();

  if (_transportType === 'log') {
    logger.warn('mailer: SMTP_HOST not configured — email not sent (log-only mode)', {
      to,
      subject,
      // Intentionally log the text body so an admin can extract the URL.
      // We never log passwords or keys, but a one-time invite/reset URL is
      // acceptable — it is the intended delivery mechanism in log mode.
      textPreview: text ? text.slice(0, 400) : '(no text body)',
    });
    return { delivered: false, transport: 'log' };
  }

  try {
    await _transport.sendMail({
      from: _from,
      to,
      subject,
      html,
      text,
    });
    logger.info('mailer: email delivered via SMTP', { to, subject });
    return { delivered: true, transport: 'smtp' };
  } catch (err) {
    logger.error('mailer: SMTP delivery failed', { to, subject, error: err.message });
    return { delivered: false, transport: 'smtp' };
  }
}

export default { sendMail };
