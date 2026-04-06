import express from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as caService from '../services/caService.js';
import prisma from '../config/db.js';

const router = express.Router();

router.use(authenticate, tenant);

// GET /api/ca/public-key — admin+; returns active CA public key + fingerprint
router.get(
  '/public-key',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const caKeyPair = await prisma.caKeyPair.findFirst({
      where: { orgId: req.orgId, isActive: true },
      select: { id: true, publicKey: true, fingerprint: true, algorithm: true, createdAt: true },
    });
    if (!caKeyPair) throw new ApiError(404, 'No active CA key pair found for organization');
    res.json({ success: true, data: { caKeyPair } });
  })
);

// GET /api/ca/status — admin+; returns CA metadata + cert count
router.get(
  '/status',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const caKeyPair = await prisma.caKeyPair.findFirst({
      where: { orgId: req.orgId, isActive: true },
      select: {
        id: true,
        fingerprint: true,
        algorithm: true,
        isActive: true,
        createdAt: true,
        rotatedAt: true,
        expiresAt: true,
      },
    });
    if (!caKeyPair) throw new ApiError(404, 'No active CA key pair found for organization');

    const certCount = await prisma.certificate.count({
      where: { orgId: req.orgId, caKeyPairId: caKeyPair.id },
    });

    res.json({
      success: true,
      data: {
        fingerprint: caKeyPair.fingerprint,
        algorithm: caKeyPair.algorithm,
        createdAt: caKeyPair.createdAt,
        rotatedAt: caKeyPair.rotatedAt,
        expiresAt: caKeyPair.expiresAt,
        isActive: caKeyPair.isActive,
        certCount,
      },
    });
  })
);

// POST /api/ca/rotate — super_admin only
router.post(
  '/rotate',
  requireRole('super_admin'),
  audit('ca.rotate', 'CaKeyPair'),
  asyncHandler(async (req, res) => {
    const name = req.body?.name || `rotated-${Date.now()}`;
    const { newKeyPair, oldKeyPairId } = await caService.rotateCaKeyPair(req.orgId, name);
    res.json({
      success: true,
      data: {
        newKeyPair: {
          id: newKeyPair.id,
          fingerprint: newKeyPair.fingerprint,
          algorithm: newKeyPair.algorithm,
          createdAt: newKeyPair.createdAt,
          isActive: newKeyPair.isActive,
        },
        oldKeyPairId,
      },
    });
  })
);

export default router;
