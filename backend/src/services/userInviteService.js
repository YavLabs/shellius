/**
 * userInviteService — sends the right "you've been added" email based on whether
 * the org has SSO enabled. Reused by the Users UI and the bulk-import flow.
 *
 *   SSO enabled  → "Sign in with <provider>" email, no password setup. The
 *                  account is linked + activated on first SSO sign-in.
 *   SSO disabled → the classic set-password invite (single-use token link).
 *
 * Never throws on email failure — returns a result the caller can inspect.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as inviteService from './inviteService.js';
import * as ssoService from './ssoService.js';
import { sendMail } from './mailer.js';
import { renderTemplate } from '../email/index.js';

const PRESET_LABELS = {
  google: 'Google',
  entra: 'Microsoft',
  okta: 'Okta',
  auth0: 'Auth0',
  'generic-oidc': 'single sign-on',
  oidc: 'single sign-on',
};

/**
 * @param {object} params
 * @param {string} params.orgId
 * @param {{ id: string, name: string, email: string }} params.user
 * @param {import('express').Request} [params.req]
 * @returns {Promise<{ mode: 'sso'|'password', inviteUrl: string|null, delivered: boolean }>}
 */
export async function sendInvite({ orgId, user, req = null }) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  const orgName = org?.name || 'Shellius';

  let sso = { enabled: false, presetId: null };
  try {
    sso = await ssoService.getPublicSsoStatus(orgId);
  } catch (err) {
    logger.debug?.('userInviteService: sso status lookup failed', { error: err.message });
  }

  if (sso.enabled) {
    // SSO mode — no token, just a link to the login page.
    const loginUrl = `${inviteService.getPublicBaseUrl(req)}/login`;
    const tpl = renderTemplate('inviteSso', {
      recipientName: user.name,
      orgName,
      loginUrl,
      providerLabel: PRESET_LABELS[sso.presetId] || 'single sign-on',
    });
    const mailResult = await sendMail({ orgId, to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    return { mode: 'sso', inviteUrl: loginUrl, delivered: !!mailResult?.delivered };
  }

  // Password mode — single-use invite token.
  const { rawToken } = await inviteService.createInvite(user.id, inviteService.TOKEN_TYPES.INVITE, 168);
  const inviteUrl = inviteService.buildTokenUrl(inviteService.TOKEN_TYPES.INVITE, rawToken, req);
  const tpl = renderTemplate('invite', {
    recipientName: user.name,
    orgName,
    inviteUrl,
    expiresInHours: 168,
  });
  const mailResult = await sendMail({ orgId, to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  return { mode: 'password', inviteUrl, delivered: !!mailResult?.delivered };
}

export default { sendInvite };
