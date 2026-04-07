import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as userService from '../services/userService.js';
import * as inviteService from '../services/inviteService.js';
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

const ROLES = ['super_admin', 'admin', 'operator', 'viewer'];
const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

// Password is now optional on create — when omitted the user is created with
// status 'invited' and receives an invite email with a one-time link.
const createSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  name: Joi.string().min(1).max(200).required(),
  password: Joi.string().min(8).max(200).optional(),
  role: Joi.string().valid(...ROLES).default('viewer'),
  managerId: Joi.string().allow(null),
  sendInvite: Joi.boolean().default(true),
});

const updateSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }),
  name: Joi.string().min(1).max(200),
  password: Joi.string().min(8).max(200),
  role: Joi.string().valid(...ROLES),
  status: Joi.string().valid(...STATUSES),
  managerId: Joi.string().allow(null),
  avatarUrl: Joi.string().uri().allow(null, ''),
}).min(1);

const sshKeySchema = Joi.object({
  publicKey: Joi.string().required(),
});

const preferencesSchema = Joi.object({
  emailNotifications: Joi.boolean(),
  expiringSoonAlerts: Joi.boolean(),
}).min(1);

router.use(authenticate, tenant);

router.get(
  '/',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const result = await userService.listUsers(req.orgId, req.query);
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
// GET /:id
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId && !['super_admin', 'admin'].includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    const user = await userService.getUser(req.orgId, id);
    res.json({ success: true, data: { user } });
  })
);

// ---------------------------------------------------------------------------
// POST / — create user; optionally send invite when no password supplied
// ---------------------------------------------------------------------------

router.post(
  '/',
  requireRole('super_admin', 'admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { sendInvite: doSendInvite, ...userData } = req.body;
    const isInviteFlow = !userData.password;

    // createUser expects a password; pass a sentinel if this is an invite
    const createData = isInviteFlow
      ? { ...userData, password: null, status: 'invited' }
      : { ...userData, status: 'active' };

    const user = await userService.createUser(req.orgId, createData, req.user.role);

    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: 'user.create',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    let inviteUrl = null;
    let mailResult = null;

    if (isInviteFlow && doSendInvite) {
      const { rawToken } = await inviteService.createInvite(user.id, inviteService.TOKEN_TYPES.INVITE, 168);
      inviteUrl = inviteService.buildTokenUrl(inviteService.TOKEN_TYPES.INVITE, rawToken, req);

      const { organization } = await import('../config/db.js').then(({ default: prisma }) =>
        prisma.organization.findUnique({ where: { id: req.orgId } })
      ).then((org) => ({ organization: org }));

      const orgName = organization?.name ?? 'Shellius';

      const tpl = renderTemplate('invite', {
        recipientName: user.name,
        orgName,
        inviteUrl,
        expiresInHours: 168,
      });
      mailResult = await sendMail({
        orgId: req.orgId,
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });

      await auditLog({
        orgId: req.orgId,
        actorId: req.user.userId,
        action: 'user.invite.sent',
        resourceType: 'User',
        resourceId: user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }

    const responseData = { user };
    // Surface the invite URL when email was not delivered (log-only mode) so the
    // admin can copy-paste it manually.
    if (inviteUrl && mailResult && !mailResult.delivered) {
      responseData.inviteUrl = inviteUrl;
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
    const { id } = req.params;
    const isSelf = id === req.user.userId;
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (!isSelf && !isAdmin) throw new ApiError(403, 'Insufficient permissions');

    if (isSelf && !isAdmin) {
      const allowed = ['name', 'password', 'avatarUrl'];
      for (const key of Object.keys(req.body)) {
        if (!allowed.includes(key)) {
          throw new ApiError(403, `You cannot change '${key}' on your own account`);
        }
      }
    }

    const user = await userService.updateUser(
      req.orgId,
      id,
      req.body,
      req.user.userId,
      req.user.role
    );
    res.json({ success: true, data: { user } });
  })
);

router.delete(
  '/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    await userService.deleteUser(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

router.put(
  '/:id/ssh-key',
  validate(sshKeySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId && !['super_admin', 'admin'].includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    await userService.uploadSshKey(req.orgId, id, req.body.publicKey);
    res.json({ success: true, data: { success: true } });
  })
);

router.delete(
  '/:id/ssh-key',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId && !['super_admin', 'admin'].includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    await userService.removeSshKey(req.orgId, id);
    res.json({ success: true, data: { success: true } });
  })
);

router.get(
  '/:id/reports',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const reports = await userService.getDirectReports(req.orgId, req.params.id);
    res.json({ success: true, data: { reports } });
  })
);

// ---------------------------------------------------------------------------
// POST /:id/resend-invite — admin+; revoke previous invite and re-issue
// ---------------------------------------------------------------------------

router.post(
  '/:id/resend-invite',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const user = await userService.getUser(req.orgId, req.params.id);
    if (!user) throw new ApiError(404, 'User not found');

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
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const user = await userService.getUser(req.orgId, req.params.id);
    if (!user) throw new ApiError(404, 'User not found');

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

// Legacy email template helpers were replaced by the shared registry under
// backend/src/email/. See renderTemplate('invite', vars) /
// renderTemplate('passwordReset', vars). Phase 16D rewrite.

export default router;
