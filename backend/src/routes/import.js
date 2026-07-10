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
    // `onboard` (true/false, default true): set false to import the server into
    // the inventory WITHOUT running agent onboarding. Not-onboarded servers
    // cannot be requested/connected until they are onboarded later.
    // dynamicIp=true → the public IP can change; users confirm/update it at connect time.
    'hostname,displayName,ipAddress,dynamicIp,customer,environment,onboard,protocol,osType,osVersion,sshUser,password,keyFile,passphrase,sudoPassword,rdpUsername,rdpPassword,labels,cloudProvider,cloudInstanceId,cloudRegion\n' +
    // root login with a key (no sudo needed)
    'web-01,Acme Prod Web,10.0.0.10,false,acme,prod,true,ssh,linux,Ubuntu 22.04,root,,keys/web-01.pem,,,,,team:web;tier:frontend,aws,i-0abc123def,ap-south-1\n' +
    // sudo user with a key + sudo password
    'app-01,Acme App,10.0.0.11,false,acme,staging,true,ssh,linux,Ubuntu 22.04,ubuntu,,keys/app-01.pem,,SudoP@ss,,,tier:app,aws,i-0app111,ap-south-1\n' +
    // cloud VM with NO static IP (public IP changes on restart)
    'ephemeral-01,Ephemeral,10.0.0.40,true,acme,dev,true,ssh,linux,Ubuntu 22.04,ubuntu,LoginP@ss,,,SudoP@ss,,,tier:scratch,aws,i-0eph222,ap-south-1\n' +
    // host that requires BOTH a key and a password to log in
    'bastion-01,Bastion,10.0.0.13,false,acme,prod,true,ssh,linux,Ubuntu 22.04,ubuntu,LoginP@ss,keys/bastion-01.pem,,SudoP@ss,,,tier:bastion,,,\n' +
    // encrypted private key (needs a passphrase) + sudo password
    'cache-01,Cache,10.0.0.14,false,acme,dev,true,ssh,linux,Ubuntu 22.04,ubuntu,,keys/cache-01.pem,KeyPassphrase,SudoP@ss,,,tier:cache,,,\n' +
    // Windows host for RDP (no SSH fields)
    'win-01,Win Host,10.0.0.20,false,acme,prod,true,rdp,windows,Windows Server 2022,,,,,,Administrator,Rdp!Pass,role:rdp,azure,vm-win-01,eastus\n' +
    // inventory only — added but NOT onboarded (no credentials needed)
    'inventory-01,Unmanaged Box,10.0.0.30,false,acme,dev,false,ssh,linux,Ubuntu 22.04,ubuntu,,,,,,,note:not-onboarded,,,\n',
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
