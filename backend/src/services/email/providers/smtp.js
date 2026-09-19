/**
 * SMTP adapter (nodemailer).
 *
 * security:
 *   tls      — implicit TLS from the first byte (usually port 465)
 *   starttls — plain connect, then STARTTLS is REQUIRED (usually 587)
 *   none     — no TLS required; nodemailer still upgrades with STARTTLS
 *              when the server offers it (opportunistic)
 *
 * The host is the one user-supplied network target in email delivery. It is
 * restricted to a bare hostname/IPv4 (no scheme/path/port), and internal
 * relays are legitimate, so private addresses are not blocked — only admins
 * holding settings.smtp can set it.
 */

import Joi from 'joi';
import nodemailer from 'nodemailer';
import { ProviderError, HTTP_TIMEOUT_MS, truncate } from '../http.js';
import { validateWith, hostname, secret } from './common.js';

export const SECURITY_MODES = ['none', 'starttls', 'tls'];

const schema = Joi.object({
  host: hostname().required(),
  port: Joi.number().integer().min(1).max(65535).default(587),
  security: Joi.string().valid(...SECURITY_MODES),
  username: Joi.string().trim().max(320).allow('', null),
  password: secret(1000).allow('', null),
});

export function defaultSecurityForPort(port) {
  return Number(port) === 465 ? 'tls' : 'starttls';
}

export function validateConfig(config) {
  const value = validateWith(schema, config);
  if (!value.security) value.security = defaultSecurityForPort(value.port);
  if (!value.username) value.username = null;
  if (!value.password) value.password = null;
  return value;
}

/** nodemailer transport options for a validated config (exported for tests). */
export function transportOptions(config) {
  const security = config.security || defaultSecurityForPort(config.port);
  return {
    host: config.host,
    port: config.port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    auth: config.username && config.password ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: HTTP_TIMEOUT_MS,
    greetingTimeout: HTTP_TIMEOUT_MS,
    socketTimeout: HTTP_TIMEOUT_MS,
  };
}

export async function send(config, message) {
  const transport = nodemailer.createTransport(transportOptions(config));
  try {
    const info = await transport.sendMail({
      from: message.from.name ? { name: message.from.name, address: message.from.address } : message.from.address,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return { messageId: info?.messageId || null };
  } catch (err) {
    // nodemailer messages carry the server's reply (e.g. "535 5.7.8
    // Authentication failed"), never the password.
    throw new ProviderError(`SMTP error: ${truncate(err?.message || 'delivery failed')}`, {
      code: err?.code || null,
      status: err?.responseCode || null,
    });
  } finally {
    transport.close();
  }
}

export default {
  type: 'smtp',
  label: 'SMTP',
  secretFields: ['password'],
  validateConfig,
  defaultFrom: (config) => (config.username && config.username.includes('@') ? config.username : null),
  send,
};
