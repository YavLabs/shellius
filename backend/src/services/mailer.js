/**
 * mailer.js
 *
 * Per-call nodemailer wrapper. Resolves SMTP config fresh on every call
 * from the DB + env merge via smtpConfigService.getEffective(). Falls
 * back to log-only mode when neither source is configured.
 *
 * When orgId is undefined (legacy callsites not yet migrated by Task 16D),
 * getEffective() uses env vars only — preserving the original behavior.
 *
 * Exported:
 *   sendMail({ orgId, to, subject, html, text })
 *     → { delivered: boolean, transport: 'smtp'|'log', error?: string }
 */

import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import { getEffective } from './smtpConfigService.js';

/**
 * Send an email. Resolves SMTP config fresh on every call from the
 * DB + env merge. Falls back to log-only mode when neither source is
 * configured.
 *
 * @param {object} params
 * @param {string} [params.orgId]   - org for per-org SMTP config lookup; if
 *                                    omitted, falls through to env defaults only
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} [params.html]
 * @param {string} [params.text]
 * @returns {Promise<{delivered: boolean, transport: 'smtp'|'log', error?: string}>}
 */
export async function sendMail({ orgId, to, subject, html, text }) {
  let cfg = null;
  try {
    cfg = await getEffective(orgId);
  } catch (err) {
    logger.warn('mailer: smtp config lookup failed', { orgId, error: err.message });
  }

  if (!cfg || !cfg.configured) {
    logger.warn('mailer: no SMTP config — email not sent (log-only mode)', {
      to,
      subject,
      // Intentionally log the text body in log-only mode so an admin can
      // extract the URL. We never log passwords or keys, but a one-time
      // invite/reset URL is acceptable here — it is the intended delivery
      // mechanism when SMTP is not set up.
      textPreview: text ? text.slice(0, 400) : '(no text body)',
    });
    return { delivered: false, transport: 'log' };
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.useTls && cfg.port === 465,
    auth: cfg.username && cfg.password
      ? { user: cfg.username, pass: cfg.password }
      : undefined,
  });

  try {
    await transport.sendMail({
      from: cfg.fromAddress || cfg.username || 'noreply@shellius.local',
      to,
      subject,
      html,
      text,
    });
    logger.info('mailer: email delivered via SMTP', { to, subject });
    return { delivered: true, transport: 'smtp' };
  } catch (err) {
    logger.error('mailer: SMTP delivery failed', { to, subject, error: err.message });
    return { delivered: false, transport: 'log', error: err.message };
  } finally {
    transport.close();
  }
}

export default { sendMail };
