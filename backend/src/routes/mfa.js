/**
 * MFA routes:
 *   /api/mfa/*           — self-service enrollment/management (authenticated)
 *   /api/settings/mfa    — per-org MFA policy (super_admin), mounted separately
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import prisma from '../config/db.js';
import * as mfaService from '../services/mfaService.js';
import * as mfaConfigService from '../services/mfaConfigService.js';

// --- self-service router (/api/mfa) -----------------------------------------

const router = express.Router();
router.use(authenticate, tenant);

async function loadUser(req) {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

// GET /api/mfa — current user's MFA status + org policy
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = await loadUser(req);
    const cfg = await mfaConfigService.getEffective(req.orgId);
    res.json({
      success: true,
      data: { status: mfaService.userMfaStatus(user), policy: cfg },
    });
  })
);

// POST /api/mfa/totp/begin — generate secret + QR
router.post(
  '/totp/begin',
  asyncHandler(async (req, res) => {
    const cfg = await mfaConfigService.getEffective(req.orgId);
    if (!cfg.allowTotp) throw new ApiError(400, 'Authenticator app MFA is not allowed');
    const user = await loadUser(req);
    const data = await mfaService.beginTotpEnroll(user);
    res.json({ success: true, data });
  })
);

const codeSchema = Joi.object({ code: Joi.string().required() });

// POST /api/mfa/totp/confirm — verify code, enable TOTP, return backup codes
router.post(
  '/totp/confirm',
  audit('mfa.totp.enabled', 'User'),
  asyncHandler(async (req, res) => {
    const { error, value } = codeSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const user = await loadUser(req);
    const { backupCodes } = await mfaService.confirmTotpEnroll(user, value.code);
    res.json({ success: true, data: { backupCodes } });
  })
);

// POST /api/mfa/email/enable
router.post(
  '/email/enable',
  audit('mfa.email.enabled', 'User'),
  asyncHandler(async (req, res) => {
    const cfg = await mfaConfigService.getEffective(req.orgId);
    if (!cfg.allowEmailOtp) throw new ApiError(400, 'Email OTP MFA is not allowed');
    const user = await loadUser(req);
    await mfaService.enableEmailOtp(user);
    res.json({ success: true, data: { enabled: true } });
  })
);

// POST /api/mfa/backup-codes/regenerate
router.post(
  '/backup-codes/regenerate',
  audit('mfa.backup.regenerated', 'User'),
  asyncHandler(async (req, res) => {
    const user = await loadUser(req);
    if (!user.mfaTotpEnabled && !user.mfaEmailEnabled) throw new ApiError(400, 'Enable MFA first');
    const backupCodes = await mfaService.regenerateBackupCodes(user);
    res.json({ success: true, data: { backupCodes } });
  })
);

// POST /api/mfa/disable
router.post(
  '/disable',
  audit('mfa.disabled', 'User'),
  asyncHandler(async (req, res) => {
    const cfg = await mfaConfigService.getEffective(req.orgId);
    if (cfg.enforced) throw new ApiError(400, 'MFA is enforced by your organization and cannot be disabled');
    await mfaService.disableMfa(req.user.userId);
    res.json({ success: true, data: { disabled: true } });
  })
);

export default router;

// --- super_admin config router (/api/settings/mfa) --------------------------

export const configRouter = express.Router();
configRouter.use(authenticate, tenant);

const mfaConfigSchema = Joi.object({
  enabled: Joi.boolean().required(),
  enforced: Joi.boolean().default(false),
  allowTotp: Joi.boolean().default(true),
  allowEmailOtp: Joi.boolean().default(true),
});

configRouter.get(
  '/',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const config = await mfaConfigService.getEffective(req.orgId);
    res.json({ success: true, data: { config } });
  })
);

configRouter.put(
  '/',
  requireRole('super_admin'),
  audit('mfa.config.updated', 'MfaConfig'),
  asyncHandler(async (req, res) => {
    const { error, value } = mfaConfigSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const row = await mfaConfigService.upsert(req.orgId, value);
    res.json({ success: true, data: { config: row } });
  })
);
