/**
 * routes/posture.js
 *
 * Exposure posture read + management API (docs/posture/posture-spec.md §7,
 * §8). Ingest (`POST /api/hosts/posture`) lives in `routes/hosts.js` and is
 * owned elsewhere — this router only reads posture data back out and lets a
 * `posture.mute`/`posture.settings` holder act on it.
 *
 * Every read here is customer-scoped (docs/rbac/customer-scope-spec.md) via
 * `req.scope`, threaded down into `postureQueryService`.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as postureQueryService from '../services/postureQueryService.js';
import * as postureSettingsService from '../services/postureSettingsService.js';
import * as postureAlertService from '../services/postureAlertService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation helpers (same shape as the rest of the route layer)
// ---------------------------------------------------------------------------

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.query = value;
  next();
};

// ---------------------------------------------------------------------------
// Shared Joi schemas
// ---------------------------------------------------------------------------

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUSES = ['open', 'muted', 'resolved'];
const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const CHANNELS = ['inapp', 'email'];

const findingsQuerySchema = Joi.object({
  severity: Joi.string().valid(...SEVERITIES),
  status: Joi.string().valid(...STATUSES),
  customerId: Joi.string(),
  environment: Joi.string().valid(...ENVIRONMENTS),
  serverId: Joi.string(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

const muteSchema = Joi.object({
  days: Joi.number().integer().min(1).max(3650),
  until: Joi.date().iso(),
  reason: Joi.string().min(1).max(1000).required(),
}).xor('days', 'until');

const portEntrySchema = Joi.object({
  port: Joi.number().integer().min(1).max(65535).required(),
  proto: Joi.string().valid('tcp', 'udp').required(),
  note: Joi.string().allow('', null).max(500),
});

const settingsUpdateSchema = Joi.object({
  enabled: Joi.boolean(),
  collectIntervalSeconds: Joi.number().integer().min(1).max(86400),
  snapshotRetentionDays: Joi.number().integer().min(1).max(365),
  metricRetentionHours: Joi.number().integer().min(1).max(8760),
  findingRetentionDays: Joi.number().integer().min(1).max(3650),
  expectedPublicPorts: Joi.array().items(portEntrySchema).max(200),
}).min(1);

const alertRuleBodySchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  isActive: Joi.boolean().default(true),
  severities: Joi.array().items(Joi.string().valid(...SEVERITIES)).default([]),
  codes: Joi.array().items(Joi.string().max(100)).default([]),
  customerIds: Joi.array().items(Joi.string()).default([]),
  environments: Joi.array().items(Joi.string().valid(...ENVIRONMENTS)).default([]),
  recipientRoles: Joi.array().items(Joi.string().max(100)).default([]),
  recipientGroupId: Joi.string().allow(null, ''),
  recipientUserIds: Joi.array().items(Joi.string()).default([]),
  channels: Joi.array().items(Joi.string().valid(...CHANNELS)).default(['inapp']),
  mode: Joi.string().valid('immediate', 'digest').default('immediate'),
  notifyOnResolve: Joi.boolean().default(false),
  throttleMinutes: Joi.number().integer().min(0).max(10080).default(0),
  escalateAfterHours: Joi.number().integer().min(1).max(720).allow(null),
  escalateToGroupId: Joi.string().allow(null, ''),
});

const alertRuleUpdateSchema = alertRuleBodySchema.fork(['name'], (s) => s.optional()).min(1);

// ---------------------------------------------------------------------------
// Every posture route requires JWT auth + tenant extraction
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// GET /api/posture/summary
// ---------------------------------------------------------------------------

router.get(
  '/summary',
  requirePermission('posture.read'),
  asyncHandler(async (req, res) => {
    const data = await postureQueryService.getSummary(req.orgId, req.scope);
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// GET /api/posture/servers — collector coverage (reporting | stale |
// not_installed), so "reporting 3 of 31" leads somewhere.
// ---------------------------------------------------------------------------

const coverageQuerySchema = Joi.object({
  state: Joi.string().valid('reporting', 'stale', 'not_installed'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

router.get(
  '/servers',
  requirePermission('posture.read'),
  asyncHandler(async (req, res) => {
    const { error, value } = coverageQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) throw new ApiError(400, error.details.map((d) => d.message).join(', '));
    const data = await postureQueryService.listServerCoverage(req.orgId, req.scope, value);
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// GET /api/posture/findings
// ---------------------------------------------------------------------------

router.get(
  '/findings',
  requirePermission('posture.read'),
  validateQuery(findingsQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await postureQueryService.listFindings(req.orgId, req.query, req.scope);
    res.json({
      success: true,
      data: {
        findings: result.findings,
        meta: { total: result.total, page: result.page, limit: result.limit },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/posture/servers/:serverId
// ---------------------------------------------------------------------------

router.get(
  '/servers/:serverId',
  requirePermission('posture.read'),
  asyncHandler(async (req, res) => {
    const data = await postureQueryService.getServerPosture(req.orgId, req.params.serverId, req.scope);
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// Finding lifecycle — posture.mute, audited
// ---------------------------------------------------------------------------

router.post(
  '/findings/:id/mute',
  requirePermission('posture.mute'),
  audit('posture.finding.mute', 'ExposureFinding'),
  validate(muteSchema),
  asyncHandler(async (req, res) => {
    const finding = await postureQueryService.muteFinding(
      req.orgId,
      req.params.id,
      req.body,
      req.user.userId,
      req.scope
    );
    res.json({ success: true, data: { finding } });
  })
);

router.post(
  '/findings/:id/unmute',
  requirePermission('posture.mute'),
  audit('posture.finding.unmute', 'ExposureFinding'),
  asyncHandler(async (req, res) => {
    const finding = await postureQueryService.unmuteFinding(req.orgId, req.params.id, req.scope);
    res.json({ success: true, data: { finding } });
  })
);

router.post(
  '/findings/:id/acknowledge',
  requirePermission('posture.mute'),
  audit('posture.finding.acknowledge', 'ExposureFinding'),
  asyncHandler(async (req, res) => {
    const finding = await postureQueryService.acknowledgeFinding(req.orgId, req.params.id, req.user.userId, req.scope);
    res.json({ success: true, data: { finding } });
  })
);

// ---------------------------------------------------------------------------
// Settings — posture.settings
// ---------------------------------------------------------------------------

router.get(
  '/settings',
  requirePermission('posture.settings'),
  asyncHandler(async (req, res) => {
    const settings = await postureSettingsService.getSettings(req.orgId);
    res.json({ success: true, data: { settings } });
  })
);

router.put(
  '/settings',
  requirePermission('posture.settings'),
  audit('posture.settings.update', 'PostureSettings'),
  validate(settingsUpdateSchema),
  asyncHandler(async (req, res) => {
    const settings = await postureSettingsService.updateSettings(req.orgId, req.body);
    res.json({ success: true, data: { settings } });
  })
);

// ---------------------------------------------------------------------------
// Alert rules — posture.settings
// ---------------------------------------------------------------------------

router.get(
  '/alert-rules',
  requirePermission('posture.settings'),
  asyncHandler(async (req, res) => {
    const rules = await postureAlertService.listAlertRules(req.orgId);
    res.json({ success: true, data: { rules } });
  })
);

router.get(
  '/alert-rules/:id',
  requirePermission('posture.settings'),
  asyncHandler(async (req, res) => {
    const rule = await postureAlertService.getAlertRule(req.orgId, req.params.id);
    res.json({ success: true, data: { rule } });
  })
);

router.post(
  '/alert-rules',
  requirePermission('posture.settings'),
  audit('posture.alert_rule.create', 'PostureAlertRule'),
  validate(alertRuleBodySchema),
  asyncHandler(async (req, res) => {
    const rule = await postureAlertService.createAlertRule(req.orgId, req.body);
    res.status(201).json({ success: true, data: { rule } });
  })
);

router.put(
  '/alert-rules/:id',
  requirePermission('posture.settings'),
  audit('posture.alert_rule.update', 'PostureAlertRule'),
  validate(alertRuleUpdateSchema),
  asyncHandler(async (req, res) => {
    const rule = await postureAlertService.updateAlertRule(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { rule } });
  })
);

router.delete(
  '/alert-rules/:id',
  requirePermission('posture.settings'),
  audit('posture.alert_rule.delete', 'PostureAlertRule'),
  asyncHandler(async (req, res) => {
    await postureAlertService.deleteAlertRule(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

export default router;
