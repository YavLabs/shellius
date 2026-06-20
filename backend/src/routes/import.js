/**
 * Bulk import routes (admin+). CSV / JSON / ZIP upload → preview → conflict
 * resolution → commit → background onboarding.
 */

import express from 'express';
import multer from 'multer';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as importService from '../services/importService.js';

const router = express.Router();
router.use(authenticate, tenant);

// In-memory upload, 25 MB cap (zip with key files stays small).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

// Multer errors (e.g. file too large) → clean 400 instead of a 500.
function handleUpload(field) {
  return (req, res, next) =>
    upload.single(field)(req, res, (err) => {
      if (err) return next(new ApiError(400, err.message || 'Upload failed'));
      next();
    });
}

// POST /api/import — upload + preview
router.post(
  '/',
  requireRole('super_admin', 'admin'),
  handleUpload('file'),
  audit('import.upload', 'ImportJob'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded (field "file")');
    const declaredType = req.body?.type || req.query?.type;
    const { jobId, summary, source } = await importService.createImportJob({
      orgId: req.orgId,
      actorId: req.user.userId,
      actorRole: req.user.role,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      declaredType,
    });
    res.status(201).json({ success: true, data: { jobId, summary, source } });
  })
);

// GET /api/import/:id — job + rows + onboarding status
router.get(
  '/:id',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const data = await importService.getJob(req.orgId, req.params.id);
    if (!data) throw new ApiError(404, 'Import job not found');
    res.json({ success: true, data });
  })
);

const decisionSchema = Joi.object({
  decision: Joi.string().valid('overwrite', 'skip').required(),
  rowIds: Joi.array().items(Joi.string()).default([]),
  applyAll: Joi.boolean().default(false),
});

// PATCH /api/import/:id/decisions — set overwrite|skip on conflict rows (bulk supported)
router.patch(
  '/:id/decisions',
  requireRole('super_admin', 'admin'),
  audit('import.decisions', 'ImportJob'),
  asyncHandler(async (req, res) => {
    const { error, value } = decisionSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const result = await importService.setDecisions({
      orgId: req.orgId,
      jobId: req.params.id,
      decision: value.decision,
      rowIds: value.rowIds,
      applyAll: value.applyAll,
    });
    res.json({ success: true, data: result });
  })
);

// POST /api/import/:id/commit — execute the plan + enqueue onboarding
router.post(
  '/:id/commit',
  requireRole('super_admin', 'admin'),
  audit('import.commit', 'ImportJob'),
  asyncHandler(async (req, res) => {
    const result = await importService.commitImportJob({
      orgId: req.orgId,
      jobId: req.params.id,
      actorId: req.user.userId,
      actorRole: req.user.role,
      req,
    });
    res.json({ success: true, data: result });
  })
);

// GET /api/import/templates/:entity.csv — downloadable sample headers
const TEMPLATES = {
  customers: 'name,slug,description\nAcme Corp,acme,Primary client\n',
  servers:
    'hostname,displayName,ipAddress,customer,environment,protocol,sshUser,password,keyFile,sudoPassword,rdpUsername,rdpPassword,labels\n' +
    'web-01,Acme Prod Web,10.0.0.10,acme,prod,ssh,ubuntu,,keys/web-01.pem,,,,team:web;tier:frontend\n',
  users: 'email,name,role,manager,sendInvite\njane@acme.com,Jane Doe,operator,,true\n',
  groups: 'name,description\nMembers,Standard members\n',
  policies:
    'name,effect,targetEnvironments,allowedPrincipals,maxSessionDuration,requireApproval,autoApprove,priority,subjectGroups,approverGroup,approverRoles\n' +
    'Dev Access,ALLOW,dev,ubuntu;root,28800,false,true,100,Members,,\n',
  memberships: 'group,user\nMembers,jane@acme.com\n',
};

router.get(
  '/templates/:entity',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.entity).replace(/\.csv$/i, '');
    const tpl = TEMPLATES[key];
    if (!tpl) throw new ApiError(404, 'Unknown template');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${key}-template.csv"`);
    res.send(tpl);
  })
);

export default router;
