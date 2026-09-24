/**
 * postureSettingsService.js
 *
 * Per-org posture configuration (docs/posture/posture-spec.md §7): whether
 * collection is enabled, the collector cadence, retention windows for
 * snapshots/metrics/findings, and the expected-public port list that keeps
 * a deliberate 80/443 from being reported as an incident.
 *
 * Create-on-read: a fresh org has no `PostureSettings` row until the first
 * GET, at which point one is created with the schema's defaults (§2). Reads
 * and writes both funnel through `getOrCreateRow` / `upsert` so a burst of
 * concurrent first-reads can never race into a unique-constraint error.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as postureAlertService from './postureAlertService.js';
import ApiError from '../utils/ApiError.js';

// Collector cadence floor — org-configurable, floor 1 minute (§4). Enforced
// here as well as at the Joi layer so any future caller of this service
// (jobs, scripts) gets the same guarantee.
const MIN_COLLECT_INTERVAL_SECONDS = 60;

function serialize(row) {
  return {
    id: row.id,
    orgId: row.orgId,
    enabled: row.enabled,
    collectIntervalSeconds: row.collectIntervalSeconds,
    snapshotRetentionDays: row.snapshotRetentionDays,
    metricRetentionHours: row.metricRetentionHours,
    findingRetentionDays: row.findingRetentionDays,
    // Json column — Prisma already hands back parsed JS, but a raw payload
    // from an old row could in principle be malformed; never let that 500.
    expectedPublicPorts: Array.isArray(row.expectedPublicPorts) ? row.expectedPublicPorts : [],
    // serialize() is a whitelist, so a new column is invisible to every
    // caller until it is named here — which is exactly how the collector
    // rollout job read `collectorAutoUpdate` as undefined and decided every
    // organization had the feature turned off.
    collectorAutoUpdate: row.collectorAutoUpdate,
    collectorCanaryPercent: row.collectorCanaryPercent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Get this org's posture settings, creating the row with schema defaults on
 * first read. `upsert` (not findUnique-then-create) so concurrent first
 * reads for the same org can't collide on the `orgId` unique constraint.
 */
export async function getSettings(orgId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  const row = await prisma.postureSettings.upsert({
    where: { orgId },
    update: {},
    create: { orgId },
  });
  // First touch of posture for this org also seeds the quiet default alert
  // rule, so an org that turns posture on gets CRITICAL alerts without having
  // to discover the rules screen first. Best-effort: never block a read.
  postureAlertService
    .ensureDefaultAlertRule(orgId)
    .catch((err) => logger.warn('postureSettingsService: default alert rule seed failed', { orgId, error: err.message }));
  return serialize(row);
}

function normalizeExpectedPublicPorts(ports) {
  if (!Array.isArray(ports)) throw new ApiError(400, 'expectedPublicPorts must be an array');
  return ports.map((p) => ({
    port: p.port,
    proto: p.proto,
    note: p.note || null,
  }));
}

/**
 * Update this org's posture settings. Only the fields present in `patch`
 * are touched — undefined fields keep their current value. Creates the row
 * first (with defaults) if this org has never had one, so a PUT before any
 * GET still behaves as an edit of the default configuration.
 */
export async function updateSettings(orgId, patch = {}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  // Ensure the row exists before the partial update below.
  await prisma.postureSettings.upsert({ where: { orgId }, update: {}, create: { orgId } });

  const data = {};

  if (patch.enabled !== undefined) data.enabled = !!patch.enabled;

  if (patch.collectIntervalSeconds !== undefined) {
    const n = parseInt(patch.collectIntervalSeconds, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new ApiError(400, 'collectIntervalSeconds must be a positive integer');
    }
    // Floor, not reject — a caller asking for 30s gets the fastest safe
    // cadence rather than an error (§4 "floor 1 minute").
    data.collectIntervalSeconds = Math.max(MIN_COLLECT_INTERVAL_SECONDS, n);
  }

  if (patch.snapshotRetentionDays !== undefined) {
    const n = parseInt(patch.snapshotRetentionDays, 10);
    if (!Number.isFinite(n) || n < 1) throw new ApiError(400, 'snapshotRetentionDays must be a positive integer');
    data.snapshotRetentionDays = n;
  }

  if (patch.metricRetentionHours !== undefined) {
    const n = parseInt(patch.metricRetentionHours, 10);
    if (!Number.isFinite(n) || n < 1) throw new ApiError(400, 'metricRetentionHours must be a positive integer');
    data.metricRetentionHours = n;
  }

  if (patch.findingRetentionDays !== undefined) {
    const n = parseInt(patch.findingRetentionDays, 10);
    if (!Number.isFinite(n) || n < 1) throw new ApiError(400, 'findingRetentionDays must be a positive integer');
    data.findingRetentionDays = n;
  }

  if (patch.expectedPublicPorts !== undefined) {
    data.expectedPublicPorts = normalizeExpectedPublicPorts(patch.expectedPublicPorts);
  }

  // Turning this on is what makes Shellius able to run new code as root on
  // every managed host with nobody pressing anything. It is a deliberate
  // decision and it is audited by the route, like every other setting here.
  if (patch.collectorAutoUpdate !== undefined) data.collectorAutoUpdate = !!patch.collectorAutoUpdate;

  if (patch.collectorCanaryPercent !== undefined) {
    const n = parseInt(patch.collectorCanaryPercent, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new ApiError(400, 'collectorCanaryPercent must be between 1 and 100');
    }
    // No floor of 0: a canary percentage of zero means "roll out to nobody",
    // which looks identical to the feature being broken.
    data.collectorCanaryPercent = n;
  }

  const row = await prisma.postureSettings.update({ where: { orgId }, data });
  return serialize(row);
}

export default { getSettings, updateSettings };
