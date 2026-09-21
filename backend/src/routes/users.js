import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission, can } from '../middleware/rbac.js';
import { actorFromReq } from '../services/roleService.js';
import audit from '../middleware/audit.js';
import { tokenActionLimiter } from '../middleware/rateLimiter.js';
import * as userService from '../services/userService.js';
import * as inviteService from '../services/inviteService.js';
import * as userInviteService from '../services/userInviteService.js';
import * as ssoLinkService from '../services/ssoLinkService.js';
import * as authService from '../services/authService.js';
import { passwordSignInBlocked } from '../services/orgService.js';
import { sendMail } from '../services/mailer.js';
import { renderTemplate } from '../email/index.js';
import { log as auditLog } from '../services/auditService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

const profileUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
});

const passwordChangeSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string()
    .min(12)
    .pattern(/[a-zA-Z]/, 'letter')
    .pattern(/[0-9]/, 'digit')
    .required()
    .messages({
      'string.min': 'New password must be at least 12 characters',
      'string.pattern.name': 'New password must contain at least one {#name}',
    }),
});

// Password is now optional on create — when omitted the user is created with
// status 'invited' and receives an invite email with a one-time link.
// accessScope/customerIds are optional (docs/rbac/customer-scope-spec.md) —
// userService.createUser validates them the same way as PUT /:id/scope, and
// requires users.assign_scope when set (checked there, not here, since it's
// a second permission layered on top of users.invite). groupIds is the same
// shape of optional-plus-service-gated field, requiring groups.manage.
const createSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  name: Joi.string().min(1).max(200).required(),
  password: Joi.string().min(8).max(200).optional(),
  // roleId: a role id or key. `role` (tier key) is the legacy spelling.
  roleId: Joi.string().max(100),
  role: Joi.string().max(100),
  managerId: Joi.string().allow(null),
  sendInvite: Joi.boolean().default(true),
  accessScope: Joi.string().valid('ALL', 'CUSTOMERS'),
  customerIds: Joi.array().items(Joi.string()).default([]),
  groupIds: Joi.array().items(Joi.string()),
});

const scopeSchema = Joi.object({
  accessScope: Joi.string().valid('ALL', 'CUSTOMERS').required(),
  customerIds: Joi.array().items(Joi.string()).default([]),
});

// No password (use a reset link or /me/password) and no avatarUrl (use
// /me/avatar, which validates the image) — see docs/rbac/rbac-audit.md F-01/F-08.
// groupIds (docs/rbac/customer-scope-spec.md §2) — optional, service-gated on
// groups.manage; self-service can never set it (userService.updateUser only
// allows 'name' for isSelf).
const updateSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }),
  name: Joi.string().min(1).max(200),
  roleId: Joi.string().max(100),
  role: Joi.string().max(100),
  status: Joi.string().valid(...STATUSES),
  managerId: Joi.string().allow(null),
  groupIds: Joi.array().items(Joi.string()),
}).min(1);

const sshKeySchema = Joi.object({
  publicKey: Joi.string().required(),
});

const preferencesSchema = Joi.object({
  emailNotifications: Joi.boolean(),
  expiringSoonAlerts: Joi.boolean(),
}).min(1);

const avatarSchema = Joi.object({
  dataUrl: Joi.string().max(300000).required(), // ~150KB decoded + base64 overhead + headroom
});

router.use(authenticate, tenant);

router.get(
  '/',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    const query = { ...req.query };
    // Query strings arrive as strings — coerce the one boolean filter so
    // `mfaEnabled=false` doesn't fall through userService's truthy check.
    if (query.mfaEnabled === 'true') query.mfaEnabled = true;
    else if (query.mfaEnabled === 'false') query.mfaEnabled = false;
    else delete query.mfaEnabled;
    const result = await userService.listUsers(req.orgId, query);
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// GET /me/preferences — any authenticated user
// Must be before /:id to prevent Express matching 'me' as an id param
// ---------------------------------------------------------------------------

router.get(
  '/me/preferences',
  asyncHandler(async (req, res) => {
    const preferences = await userService.getPreferences(req.user.userId);
    res.json({ success: true, data: { preferences } });
  })
);

// PUT /me/preferences — any authenticated user
router.put(
  '/me/preferences',
  validate(preferencesSchema),
  audit('user.preferences.update', 'User'),
  asyncHandler(async (req, res) => {
    const preferences = await userService.updatePreferences(req.user.userId, req.body);
    res.json({ success: true, data: { preferences } });
  })
);

// ---------------------------------------------------------------------------
// GET /me — return the calling user's full profile
// ---------------------------------------------------------------------------

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await userService.getUser(req.orgId, req.user.userId);
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// PUT /me — update name only (NOT email, role, or other fields)
// ---------------------------------------------------------------------------

router.put(
  '/me',
  validate(profileUpdateSchema),
  audit('user.profile.updated', 'User'),
  asyncHandler(async (req, res) => {
    const user = await userService.updateProfile(req.user.userId, req.body.name);
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// PUT /me/avatar — upload a custom avatar (strict Joi + server-side decode
// validation in userService/utils/avatar.js). DELETE removes it.
// ---------------------------------------------------------------------------

router.put(
  '/me/avatar',
  validate(avatarSchema),
  audit('user.avatar.updated', 'User'),
  asyncHandler(async (req, res) => {
    const user = await userService.setAvatar(req.user.userId, req.body.dataUrl);
    res.json({ success: true, data: { user } });
  })
);

router.delete(
  '/me/avatar',
  audit('user.avatar.removed', 'User'),
  asyncHandler(async (req, res) => {
    const user = await userService.clearAvatar(req.user.userId);
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// PUT /me/password — change password (LOCAL users only)
// ---------------------------------------------------------------------------

router.put(
  '/me/password',
  tokenActionLimiter,
  validate(passwordChangeSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    // changePassword throws ApiError on mismatch or SSO account; revokes
    // every other session and returns a fresh token pair for the caller.
    const tokens = await userService.changePassword(
      req.user.userId,
      currentPassword,
      newPassword,
      req.ip,
      req.get('user-agent') || ''
    );

    // Send security notification email (fire-and-forget; never block the response)
    setImmediate(async () => {
      try {
        const user = await userService.getUser(req.orgId, req.user.userId);
        const tpl = renderTemplate('passwordChanged', {
          recipientName: user.name,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
          when: new Date().toISOString(),
        });
        await sendMail({
          orgId: req.orgId,
          to: user.email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });
      } catch (err) {
        const logger = (await import('../utils/logger.js')).default;
        logger.error('PUT /me/password: failed to send notification email', { error: err.message });
      }
    });

    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: 'user.password.changed',
      resourceType: 'User',
      resourceId: req.user.userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true, data: tokens });
  })
);

// ---------------------------------------------------------------------------
// GET /me/export — GDPR data export
// ---------------------------------------------------------------------------

router.get(
  '/me/export',
  audit('user.data.exported', 'User'),
  asyncHandler(async (req, res) => {
    const exportData = await userService.exportUserData(req.orgId, req.user.userId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `shellius-export-${req.user.userId}-${timestamp}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(JSON.stringify(exportData, null, 2));
  })
);

// ---------------------------------------------------------------------------
// DELETE /me — soft-delete account
// ---------------------------------------------------------------------------

router.delete(
  '/me',
  asyncHandler(async (req, res) => {
    // softDeleteSelf handles guards: already-deleted, only super_admin
    await userService.softDeleteSelf(req.orgId, req.user.userId);

    // Send confirmation email (fire-and-forget)
    setImmediate(async () => {
      try {
        // We must fetch user info BEFORE soft-delete, but softDeleteSelf doesn't
        // return it — re-fetch using raw prisma to bypass the strip/not-deleted filter
        const { default: prisma } = await import('../config/db.js');
        const deletedUser = await prisma.user.findUnique({
          where: { id: req.user.userId },
          select: { email: true, name: true, orgId: true },
        });
        if (deletedUser) {
          const tpl = renderTemplate('accountDeleted', {
            recipientName: deletedUser.name,
            when: new Date().toISOString(),
            gracePeriodDays: 30,
          });
          await sendMail({
            orgId: deletedUser.orgId,
            to: deletedUser.email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
          });
        }
      } catch (err) {
        const logger = (await import('../utils/logger.js')).default;
        logger.error('DELETE /me: failed to send account-deleted email', { error: err.message });
      }
    });

    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: 'user.account.deleted',
      resourceType: 'User',
      resourceId: req.user.userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const isSelf = id === req.user.userId;
    if (!isSelf && !can(req, 'users.view') && !can(req, 'users.view_reports')) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    const user = await userService.getUser(req.orgId, id);
    if (!isSelf && !can(req, 'users.view') && user.managerId !== req.user.userId) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// POST / — create user; optionally send invite when no password supplied
// ---------------------------------------------------------------------------

router.post(
  '/',
  requirePermission('users.invite'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { sendInvite: doSendInvite, ...userData } = req.body;
    const isInviteFlow = !userData.password;

    // createUser expects a password; pass a sentinel if this is an invite
    const createData = isInviteFlow
      ? { ...userData, password: null, status: 'invited' }
      : { ...userData, status: 'active' };

    const user = await userService.createUser(req.orgId, createData, actorFromReq(req), req.scope, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: 'user.create',
      resourceType: 'User',
      resourceId: user.id,
      metadata: { role: user.roleInfo?.name },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    let invite = null;

    if (isInviteFlow && doSendInvite) {
      // Picks the SSO "sign in" email or the classic set-password invite based
      // on whether the org has SSO enabled.
      invite = await userInviteService.sendInvite({ orgId: req.orgId, user, req });

      await auditLog({
        orgId: req.orgId,
        actorId: req.user.userId,
        action: 'user.invite.sent',
        resourceType: 'User',
        resourceId: user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { mode: invite.mode },
      });
    }

    const responseData = { user };
    // Surface the invite URL when email was not delivered (log-only mode) so the
    // admin can copy-paste it manually.
    if (invite && invite.inviteUrl && !invite.delivered) {
      responseData.inviteUrl = invite.inviteUrl;
    }

    res.status(201).json({ success: true, data: responseData });
  })
);

// ---------------------------------------------------------------------------
// PUT /:id
// ---------------------------------------------------------------------------

router.put(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    // Permission and target checks live in userService.updateUser so the
    // import path gets the same rules.
    const user = await userService.updateUser(req.orgId, req.params.id, req.body, actorFromReq(req), {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/scope — set accessScope + the UserCustomerScope rows
// (docs/rbac/customer-scope-spec.md). All the interesting rules (self,
// super_admin, out-of-scope grants, org membership) live in the service.
// ---------------------------------------------------------------------------

router.put(
  '/:id/scope',
  requirePermission('users.assign_scope'),
  validate(scopeSchema),
  asyncHandler(async (req, res) => {
    const user = await userService.assignUserScope(req.orgId, req.params.id, req.body, actorFromReq(req), req.scope, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// GET /:id/effective-scope — explains WHY, for the "effective access" UI
// (docs/rbac/customer-scope-spec.md §7 phase 4, §2 groups decision).
// ---------------------------------------------------------------------------

router.get(
  '/:id/effective-scope',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    const data = await userService.getEffectiveScope(req.orgId, req.params.id);
    res.json({ success: true, data });
  })
);

router.get(
  '/:id/delete-impact',
  requirePermission('users.delete'),
  asyncHandler(async (req, res) => {
    const impact = await userService.getUserDeleteImpact(req.orgId, req.params.id);
    res.json({ success: true, data: impact });
  })
);

router.delete(
  '/:id',
  requirePermission('users.delete'),
  asyncHandler(async (req, res) => {
    await userService.deleteUser(
      req.orgId,
      req.params.id,
      { reassignReportsTo: req.body?.reassignReportsTo },
      req.user.userId,
      actorFromReq(req)
    );
    res.json({ success: true, data: { success: true } });
  })
);

router.put(
  '/:id/ssh-key',
  validate(sshKeySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId) {
      if (!can(req, 'users.update')) throw new ApiError(403, 'Insufficient permissions');
      const target = await userService.getUser(req.orgId, id);
      await userService.assertCanManageUser(req.orgId, actorFromReq(req), target, "change this user's SSH key");
    }
    await userService.uploadSshKey(req.orgId, id, req.body.publicKey);
    res.json({ success: true, data: { success: true } });
  })
);

router.delete(
  '/:id/ssh-key',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId) {
      if (!can(req, 'users.update')) throw new ApiError(403, 'Insufficient permissions');
      const target = await userService.getUser(req.orgId, id);
      await userService.assertCanManageUser(req.orgId, actorFromReq(req), target, "change this user's SSH key");
    }
    await userService.removeSshKey(req.orgId, id);
    res.json({ success: true, data: { success: true } });
  })
);

router.get(
  '/:id/reports',
  asyncHandler(async (req, res) => {
    const own = req.params.id === req.user.userId && can(req, 'users.view_reports');
    if (!own && !can(req, 'users.view')) throw new ApiError(403, 'Insufficient permissions');
    const reports = await userService.getDirectReports(req.orgId, req.params.id);
    res.json({ success: true, data: { reports } });
  })
);

// ---------------------------------------------------------------------------
// POST /:id/resend-invite — admin+; revoke previous invite and re-issue
// ---------------------------------------------------------------------------

router.post(
  '/:id/resend-invite',
  requirePermission('users.invite'),
  asyncHandler(async (req, res) => {
    const user = await userService.getUser(req.orgId, req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    await userService.assertCanManageUser(req.orgId, actorFromReq(req), user, 'invite this user');
    // An invite sets the password and activates the account, so it is only
    // for users who haven't accepted yet (F-02 / F-11).
    if (user.status !== 'invited') {
      throw new ApiError(409, 'This user has already joined — send a password reset link instead');
    }

    const { rawToken } = await inviteService.createInvite(user.id, inviteService.TOKEN_TYPES.INVITE, 168);
    const inviteUrl = inviteService.buildTokenUrl(inviteService.TOKEN_TYPES.INVITE, rawToken, req);

    const orgRecord = await import('../config/db.js').then(({ default: prisma }) =>
      prisma.organization.findUnique({ where: { id: req.orgId } })
    );
    const orgName = orgRecord?.name ?? 'Shellius';

    const inviteTpl = renderTemplate('invite', {
      recipientName: user.name,
      orgName,
      inviteUrl,
      expiresInHours: 168,
    });
    const mailResult = await sendMail({
      orgId: req.orgId,
      to: user.email,
      subject: inviteTpl.subject,
      html: inviteTpl.html,
      text: inviteTpl.text,
    });

    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: 'user.invite.resent',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const data = { success: true };
    if (!mailResult.delivered) data.inviteUrl = inviteUrl;
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// POST /:id/password-reset — admin+; issue a 1-hour reset token for a user
// ---------------------------------------------------------------------------

router.post(
  '/:id/password-reset',
  requirePermission('users.reset_credentials'),
  asyncHandler(async (req, res) => {
    const user = await userService.getUser(req.orgId, req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    await userService.assertCanManageUser(req.orgId, actorFromReq(req), user, "reset this user's password");
    if (user.status !== 'active') throw new ApiError(409, 'Only active users can reset their password');
    // Org requires SSO and this user isn't exempt — a reset link would be useless.
    if (await passwordSignInBlocked(user)) throw authService.ssoRequiredError();

    const { rawToken } = await inviteService.createInvite(user.id, inviteService.TOKEN_TYPES.PASSWORD_RESET, 1);
    const resetUrl = inviteService.buildTokenUrl(inviteService.TOKEN_TYPES.PASSWORD_RESET, rawToken, req);

    const orgRecord = await import('../config/db.js').then(({ default: prisma }) =>
      prisma.organization.findUnique({ where: { id: req.orgId } })
    );
    const orgName = orgRecord?.name ?? 'Shellius';

    const resetTpl = renderTemplate('passwordReset', {
      recipientName: user.name,
      resetUrl,
      expiresInHours: 1,
    });
    const mailResult = await sendMail({
      orgId: req.orgId,
      to: user.email,
      subject: resetTpl.subject,
      html: resetTpl.html,
      text: resetTpl.text,
    });

    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: 'user.password.reset_requested',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const data = { success: true };
    if (!mailResult.delivered) data.resetUrl = resetUrl;
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// Sign-in methods — GET /:id/identities, DELETE /:id/identities/:identityId
// (users.manage_identities). Same no-escalation rule as managing the user
// (roleService.canActOnRole), and the last way to sign in can't be removed.
// Unlinks are audited (auth.identity.unlinked, method: admin) and the user
// is emailed.
// ---------------------------------------------------------------------------

router.get(
  '/:id/identities',
  requirePermission('users.manage_identities'),
  asyncHandler(async (req, res) => {
    const data = await ssoLinkService.listIdentitiesForAdmin({
      orgId: req.orgId,
      actor: actorFromReq(req),
      userId: req.params.id,
    });
    res.json({ success: true, data });
  })
);

router.delete(
  '/:id/identities/:identityId',
  requirePermission('users.manage_identities'),
  asyncHandler(async (req, res) => {
    const data = await ssoLinkService.adminUnlinkIdentity({
      orgId: req.orgId,
      actor: actorFromReq(req),
      userId: req.params.id,
      identityId: req.params.identityId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// POST /:id/unlock — admin+; clears a lockout (failedLoginCount/lockedUntil)
// ---------------------------------------------------------------------------

router.post(
  '/:id/unlock',
  requirePermission('users.reset_credentials'),
  audit('user.unlocked', 'User'),
  asyncHandler(async (req, res) => {
    const user = await userService.unlockUser(req.orgId, req.params.id, actorFromReq(req));
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// POST /:id/revoke-sessions — admin+; revokes every session + bumps
// sessionsValidFrom so all of the user's outstanding access tokens die too
// ---------------------------------------------------------------------------

router.post(
  '/:id/revoke-sessions',
  requirePermission('users.revoke_sessions'),
  audit('user.sessions.revoked', 'User'),
  asyncHandler(async (req, res) => {
    const result = await userService.adminRevokeSessions(req.orgId, req.params.id, actorFromReq(req));
    res.json({ success: true, data: result });
  })
);

// Legacy email template helpers were replaced by the shared registry under
// backend/src/email/. See renderTemplate('invite', vars) /
// renderTemplate('passwordReset', vars). Phase 16D rewrite.

export default router;
