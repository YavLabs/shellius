/**
 * Email template registry.
 *
 * Each template module exports a `render(vars) → { subject, html, text }`
 * function. Add a new template by dropping a file under templates/ and
 * registering it here.
 *
 * Use:
 *   import { renderTemplate } from '../email/index.js';
 *   const { subject, html, text } = renderTemplate('invite', { ... });
 *   await sendMail({ orgId, to, subject, html, text });
 */

import * as invite from './templates/invite.js';
import * as inviteSso from './templates/inviteSso.js';
import * as passwordReset from './templates/passwordReset.js';
import * as passwordChanged from './templates/passwordChanged.js';
import * as accessRequestSubmitted from './templates/accessRequestSubmitted.js';
import * as accessRequestApprovalNeeded from './templates/accessRequestApprovalNeeded.js';
import * as accessRequestApproved from './templates/accessRequestApproved.js';
import * as accessRequestDenied from './templates/accessRequestDenied.js';
import * as certificateExpiring from './templates/certificateExpiring.js';
import * as accountDeleted from './templates/accountDeleted.js';
import * as verifyEmail from './templates/verifyEmail.js';
import * as smtpTest from './templates/smtpTest.js';
import * as mfaOtp from './templates/mfaOtp.js';
import * as identityLinked from './templates/identityLinked.js';
import * as identityUnlinked from './templates/identityUnlinked.js';
import * as ssoLinkApproval from './templates/ssoLinkApproval.js';

const TEMPLATES = {
  invite,
  inviteSso,
  passwordReset,
  passwordChanged,
  accessRequestSubmitted,
  accessRequestApprovalNeeded,
  accessRequestApproved,
  accessRequestDenied,
  certificateExpiring,
  accountDeleted,
  verifyEmail,
  smtpTest,
  mfaOtp,
  identityLinked,
  identityUnlinked,
  ssoLinkApproval,
};

export function renderTemplate(name, vars) {
  const tpl = TEMPLATES[name];
  if (!tpl || typeof tpl.render !== 'function') {
    throw new Error(`Unknown email template: ${name}`);
  }
  return tpl.render(vars);
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);
export default { renderTemplate, TEMPLATE_NAMES };
