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
import * as postureInventoryService from '../services/postureInventoryService.js';
import * as postureSettingsService from '../services/postureSettingsService.js';
import * as postureAlertService from '../services/postureAlertService.js';
import * as postureExportService from '../services/postureExportService.js';
import * as postureExpectedPortService from '../services/postureExpectedPortService.js';

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
  // The findings inbox's own partition — open / expected / acknowledged /
  // muted / resolved. Takes precedence over `status`.
  section: Joi.string().valid('open', 'expected', 'acknowledged', 'muted', 'resolved'),
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

const summaryQuerySchema = Joi.object({
  customerId: Joi.string(),
  environment: Joi.string().valid(...ENVIRONMENTS),
});

router.get(
  '/summary',
  requirePermission('posture.read'),
  validateQuery(summaryQuerySchema),
  asyncHandler(async (req, res) => {
    const data = await postureQueryService.getSummary(req.orgId, req.scope, {
      customerId: req.query.customerId,
      environment: req.query.environment,
    });
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
// GET /api/posture/servers/:serverId/metrics — resource history drill-down
// ---------------------------------------------------------------------------

const metricsQuerySchema = Joi.object({
  from: Joi.date().iso(),
  to: Joi.date().iso(),
  // `auto` picks a bucket that keeps the range under ~500 points.
  bucket: Joi.string().valid('auto', ...Object.keys(postureQueryService.METRIC_BUCKETS)).default('auto'),
});

router.get(
  '/servers/:serverId/metrics',
  requirePermission('posture.read'),
  validateQuery(metricsQuerySchema),
  asyncHandler(async (req, res) => {
    const data = await postureQueryService.getServerMetrics(
      req.orgId,
      req.params.serverId,
      req.scope,
      req.query
    );
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// Per-server expected-public ports — posture.expected_ports, audited
// ---------------------------------------------------------------------------

const expectedPortsSchema = Joi.object({
  entries: Joi.array()
    .items(
      Joi.object({
        port: Joi.number().integer().min(1).max(65535).required(),
        proto: Joi.string().valid('tcp', 'udp', 'any').default('any'),
        // Required for the same reason a mute reason is: a suppression with
        // no stated cause is indistinguishable from a mistake later.
        note: Joi.string().trim().min(1).max(500).required(),
      })
    )
    .min(1)
    .max(100)
    .required(),
});

router.get(
  '/servers/:serverId/expected-ports',
  requirePermission('posture.read'),
  asyncHandler(async (req, res) => {
    const items = await postureExpectedPortService.listForServer(req.orgId, req.params.serverId, req.scope);
    res.json({ success: true, data: { items } });
  })
);

router.post(
  '/servers/:serverId/expected-ports',
  requirePermission('posture.expected_ports'),
  audit('posture.expected_port.add', 'Server'),
  validate(expectedPortsSchema),
  asyncHandler(async (req, res) => {
    const data = await postureExpectedPortService.addForServer(
      req.orgId,
      req.params.serverId,
      req.body.entries,
      { actorId: req.user.userId, scope: req.scope }
    );
    res.json({ success: true, data });
  })
);

router.delete(
  '/servers/:serverId/expected-ports/:entryId',
  requirePermission('posture.expected_ports'),
  audit('posture.expected_port.remove', 'Server'),
  asyncHandler(async (req, res) => {
    const data = await postureExpectedPortService.removeForServer(
      req.orgId,
      req.params.serverId,
      req.params.entryId,
      { scope: req.scope }
    );
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// Export — posture.export, audited
// ---------------------------------------------------------------------------

router.get(
  '/export/fields',
  requirePermission('posture.export'),
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        findings: postureExportService.fieldCatalogue('findings'),
        listeners: postureExportService.fieldCatalogue('listeners'),
        formats: postureExportService.FORMATS,
      },
    });
  })
);

const exportSchema = Joi.object({
  dataset: Joi.string().valid('findings', 'listeners').required(),
  format: Joi.string().valid(...postureExportService.FORMATS).default('csv'),
  bundle: Joi.string().valid(...postureExportService.BUNDLES).default('single'),
  // Empty / omitted means every field in the catalogue.
  fields: Joi.array().items(Joi.string().max(64)).max(64).default([]),
  filters: Joi.object({
    serverId: Joi.string(),
    serverIds: Joi.array().items(Joi.string()).max(2000),
    status: Joi.string().valid('open', 'muted', 'resolved', 'all'),
    severity: Joi.string().valid('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'),
    code: Joi.string().max(64),
    environment: Joi.string().max(32),
    customerId: Joi.string(),
    // Service-inventory filters (listeners dataset). Exporting from that page
    // has to carry the same filters the page is showing.
    proto: Joi.string().max(8),
    reachability: Joi.string().max(16),
    ownerKind: Joi.string().max(32),
    port: Joi.number().integer().min(0).max(65535),
    serviceKey: Joi.string().max(160),
    q: Joi.string().max(200).allow(''),
  }).default({}),
});

// POST, not GET: the field selection and a bulk server list do not belong in
// a URL, and an export is a recorded action rather than a cacheable read.
router.post(
  '/export',
  requirePermission('posture.export'),
  audit('posture.export', 'Posture'),
  validate(exportSchema),
  asyncHandler(async (req, res) => {
    const { dataset, format, bundle, fields, filters } = req.body;
    const result = await postureExportService.buildExport({
      orgId: req.orgId,
      scope: req.scope,
      dataset,
      format,
      bundle,
      fields,
      filters,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    // Read by the frontend so it can report what was actually exported —
    // "0 rows" is a result worth showing, not a silent empty file.
    res.setHeader('X-Export-Rows', String(result.rowCount));
    res.setHeader('X-Export-Servers', String(result.serverCount));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows, X-Export-Servers');
    res.send(result.buffer);
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


// ---------------------------------------------------------------------------
// Service inventory — what is running across the fleet, not what is wrong
// ---------------------------------------------------------------------------

const inventoryQuerySchema = Joi.object({
  q: Joi.string().max(200).allow(''),
  proto: Joi.string().max(8).allow(''),
  reachability: Joi.string().max(16).allow(''),
  ownerKind: Joi.string().max(32).allow(''),
  port: Joi.number().integer().min(0).max(65535).allow(''),
  portMin: Joi.number().integer().min(0).max(65535),
  portMax: Joi.number().integer().min(0).max(65535),
  serverId: Joi.string().allow(''),
  customerId: Joi.string().allow(''),
  environment: Joi.string().max(32).allow(''),
  serviceKey: Joi.string().max(160).allow(''),
  // 'stopped' is the half a socket scan cannot see: installed services that
  // still declare ports and still have firewall rules.
  state: Joi.string().valid('running', 'stopped').allow(''),
  hasFindings: Joi.boolean(),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
}).unknown(false);

// GET /api/posture/inventory/services — one row per distinct service.
router.get(
  '/inventory/services',
  requirePermission('posture.read'),
  validateQuery(inventoryQuerySchema),
  asyncHandler(async (req, res) => {
    const data = await postureInventoryService.listServices(req.orgId, req.query, req.scope);
    res.json({ success: true, data });
  })
);

// GET /api/posture/inventory/listeners — the flat port list across the fleet.
router.get(
  '/inventory/listeners',
  requirePermission('posture.read'),
  validateQuery(inventoryQuerySchema),
  asyncHandler(async (req, res) => {
    const data = await postureInventoryService.listListeners(req.orgId, req.query, req.scope);
    res.json({ success: true, data });
  })
);

// GET /api/posture/inventory/facets — distinct filter values, in scope.
router.get(
  '/inventory/facets',
  requirePermission('posture.read'),
  asyncHandler(async (req, res) => {
    const data = await postureInventoryService.listFacets(req.orgId, req.scope);
    res.json({ success: true, data });
  })
);

export default router;
