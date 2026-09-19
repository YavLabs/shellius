/**
 * The SMTP_* environment fallback, used when an org has no active email
 * provider. Behaviour matches releases before multi-provider delivery:
 * implicit TLS on port 465, otherwise STARTTLS when the server offers it.
 * SMTP_SECURITY=none|starttls|tls overrides that explicitly.
 */

import { SECURITY_MODES } from './providers/smtp.js';

export function envSmtpConfigured() {
  return !!process.env.SMTP_HOST;
}

export function envSmtpSecurity(port) {
  const explicit = String(process.env.SMTP_SECURITY || '').trim().toLowerCase();
  if (SECURITY_MODES.includes(explicit)) return explicit;
  if (port === 465 && process.env.SMTP_SECURE !== 'false') return 'tls';
  // 'none' = TLS not required; nodemailer still upgrades via STARTTLS when offered.
  return 'none';
}

/** Provider definition for the env SMTP settings, or null when SMTP_HOST is unset. */
export function envSmtpProvider() {
  if (!envSmtpConfigured()) return null;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) || 587 : 587;
  return {
    type: 'smtp',
    name: 'SMTP (environment)',
    fromAddress: process.env.SMTP_FROM || null,
    fromName: process.env.SMTP_FROM_NAME || null,
    config: {
      host: process.env.SMTP_HOST,
      port,
      security: envSmtpSecurity(port),
      username: process.env.SMTP_USER || null,
      password: process.env.SMTP_PASS || null,
    },
  };
}

export default { envSmtpConfigured, envSmtpProvider, envSmtpSecurity };
