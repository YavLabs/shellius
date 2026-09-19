/**
 * mailer.js
 *
 * Single entry point for outbound email. Resolution order, fresh on every
 * call (docs/email-delivery.md):
 *
 *   1. the org's active EmailProvider (Settings → Email)
 *   2. SMTP_* environment variables              → transport 'env-smtp'
 *   3. log-only mode (nothing is sent)            → transport 'log'
 *
 * Exported:
 *   sendMail({ orgId, to, subject, html, text })
 *     → { delivered: boolean, transport: <provider type>|'env-smtp'|'log', error?: string }
 *
 * Callers (mfaService, invites, approvals…) rely on `delivered`. Failures are
 * logged with the provider's name/type and its error text — never
 * credentials.
 */

import logger from '../utils/logger.js';
import { getActiveForSend } from './emailProviderService.js';
import { sendWith } from './email/providers/index.js';
import { envSmtpProvider } from './email/envSmtp.js';

/**
 * Send an email.
 *
 * @param {object} params
 * @param {string} [params.orgId]   - org whose active provider to use; when
 *                                    omitted only the env fallback applies
 * @param {string|string[]} params.to
 * @param {string} params.subject
 * @param {string} [params.html]
 * @param {string} [params.text]
 * @returns {Promise<{delivered: boolean, transport: string, error?: string}>}
 */
export async function sendMail({ orgId, to, subject, html, text }) {
  let provider = null;
  let transport = null;

  if (orgId) {
    try {
      provider = await getActiveForSend(orgId);
      if (provider) transport = provider.type;
    } catch (err) {
      logger.warn('mailer: email provider lookup failed — trying env SMTP', { orgId, error: err.message });
    }
  }

  if (!provider) {
    provider = envSmtpProvider();
    if (provider) transport = 'env-smtp';
  }

  if (!provider) {
    logger.warn('mailer: no email provider configured — email not sent (log-only mode)', {
      to,
      subject,
      // Intentionally log the text body in log-only mode so an admin can
      // extract the URL. We never log passwords or keys, but a one-time
      // invite/reset URL is acceptable here — it is the intended delivery
      // mechanism when email is not set up.
      textPreview: text ? text.slice(0, 400) : '(no text body)',
    });
    return { delivered: false, transport: 'log' };
  }

  if (!provider.config) {
    const error = 'Email provider settings are not available';
    logger.error('mailer: email delivery failed', { orgId, to, subject, provider: provider.name, type: provider.type, error });
    return { delivered: false, transport, error };
  }

  try {
    await sendWith(provider, { to, subject, html, text });
    logger.info('mailer: email delivered', { orgId, to, subject, provider: provider.name, type: transport });
    return { delivered: true, transport };
  } catch (err) {
    const error = err?.message || 'Delivery failed';
    logger.error('mailer: email delivery failed', { orgId, to, subject, provider: provider.name, type: transport, error });
    return { delivered: false, transport, error };
  }
}

export default { sendMail };
