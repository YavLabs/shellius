/**
 * postureAlertService.js
 *
 * `PostureAlertRule` (docs/posture/posture-spec.md §6) — who gets told about
 * a finding, and the dispatcher that actually tells them.
 *
 * Routing rules that keep this from becoming noise, all enforced here:
 *   1. TRANSITIONS notify, scans do not — a finding open across 300 scans is
 *      one notification. `postureService.ingest()` passes only transitions.
 *   2. A MUTED finding notifies nobody, escalations included.
 *   3. Recipients are intersected with customer scope, so a rule can never be
 *      used to tell someone about a server they cannot see.
 *   4. `throttleMinutes` collapses repeat traffic per (finding, rule).
 *   5. Resolution notices are opt-in per rule (`notifyOnResolve`).
 *
 * Rules are an org-wide admin surface (`posture.settings`), not
 * customer-scoped — a rule's own `customerIds` field is how it targets a
 * subset of the org, same as an access policy's `customerId`.
 */

import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import redis from '../config/redis.js';
import { TIERS } from '../config/permissions.js';
import { resolveScope, isUnscoped } from '../lib/scope.js';
import * as notificationService from './notificationService.js';
import { notifyEvent } from './notify/notifyService.js';
import * as mailer from './mailer.js';
import { escapeHtml as esc } from '../email/escape.js';

const WRITABLE_FIELDS = [
  'name',
  'isActive',
  'severities',
  'codes',
  'customerIds',
  'environments',
  'recipientRoles',
  'recipientGroupId',
  'recipientUserIds',
  'channels',
  'mode',
  'digestSchedule',
  'digestHour',
  'digestDayOfWeek',
  'notifyOnResolve',
  'throttleMinutes',
  'escalateAfterHours',
  'escalateToGroupId',
];

function pick(data = {}) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (data[key] !== undefined) out[key] = data[key] === '' && key.endsWith('GroupId') ? null : data[key];
  }
  return out;
}

async function assertGroupExists(orgId, groupId, field) {
  if (!groupId) return;
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId }, select: { id: true } });
  if (!group) throw new ApiError(400, `${field} does not reference a group in this organization`);
}

async function assertCustomersExist(orgId, customerIds = []) {
  if (!customerIds.length) return;
  const count = await prisma.customer.count({ where: { orgId, id: { in: customerIds } } });
  if (count !== customerIds.length) {
    throw new ApiError(400, 'customerIds must all belong to this organization');
  }
}

export async function listAlertRules(orgId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  return prisma.postureAlertRule.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
}

export async function getAlertRule(orgId, id) {
  const rule = await prisma.postureAlertRule.findFirst({ where: { id, orgId } });
  if (!rule) throw new ApiError(404, 'Alert rule not found');
  return rule;
}

export async function createAlertRule(orgId, data) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  const payload = pick(data);
  if (!payload.name) throw new ApiError(400, 'name is required');

  await Promise.all([
    assertGroupExists(orgId, payload.recipientGroupId, 'recipientGroupId'),
    assertGroupExists(orgId, payload.escalateToGroupId, 'escalateToGroupId'),
    assertCustomersExist(orgId, payload.customerIds),
  ]);

  // Start the digest watermark at creation. Without it the job would fall
  // back to `createdAt`, which is the same instant here but would not be
  // after a later edit — see updateAlertRule.
  if (payload.mode === 'digest') payload.lastDigestAt = new Date();

  try {
    return await prisma.postureAlertRule.create({ data: { orgId, ...payload } });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'An alert rule with this name already exists');
    throw err;
  }
}

export async function updateAlertRule(orgId, id, data) {
  const existing = await prisma.postureAlertRule.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Alert rule not found');

  const payload = pick(data);

  await Promise.all([
    payload.recipientGroupId !== undefined
      ? assertGroupExists(orgId, payload.recipientGroupId, 'recipientGroupId')
      : Promise.resolve(),
    payload.escalateToGroupId !== undefined
      ? assertGroupExists(orgId, payload.escalateToGroupId, 'escalateToGroupId')
      : Promise.resolve(),
    payload.customerIds !== undefined ? assertCustomersExist(orgId, payload.customerIds) : Promise.resolve(),
  ]);

  // Switching an existing rule INTO digest mode restarts the watermark.
  // Otherwise the job would anchor on `createdAt`, and a year-old rule
  // switched to digest this morning would send a first digest covering
  // everything back to the window clamp — a month of findings, presented as
  // if they had just happened.
  if (payload.mode === 'digest' && existing.mode !== 'digest') {
    payload.lastDigestAt = new Date();
  }

  try {
    return await prisma.postureAlertRule.update({ where: { id }, data: payload });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'An alert rule with this name already exists');
    throw err;
  }
}

export async function deleteAlertRule(orgId, id) {
  const existing = await prisma.postureAlertRule.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Alert rule not found');
  await prisma.postureAlertRule.delete({ where: { id } });
  return { success: true };
}


// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const THROTTLE_PREFIX = 'posture:alert:';

/** Does this rule care about this finding on this server? Empty field = any. */
export function ruleMatches(rule, { finding, server }) {
  if (!rule.isActive) return false;
  if (rule.severities?.length && !rule.severities.includes(finding.severity)) return false;
  if (rule.codes?.length && !rule.codes.includes(finding.code)) return false;
  if (rule.customerIds?.length && !rule.customerIds.includes(server.customerId)) return false;
  if (rule.environments?.length && !rule.environments.includes(server.environment)) return false;
  return true;
}

/** Which event types a rule wants. Resolution notices are opt-in. */
function ruleWantsEvent(rule, type) {
  if (type === 'resolved') return !!rule.notifyOnResolve;
  return type === 'opened' || type === 'reopened' || type === 'severity_increased' || type === 'escalation';
}

/**
 * Users a rule addresses: explicit ids ∪ role holders ∪ group members.
 * Mirrors accessRequestService.resolveApprovers so "who gets told" has one
 * shape across the product.
 */
export async function resolveRecipients(orgId, rule, { escalating = false } = {}) {
  const orFilters = [];
  if (rule.recipientUserIds?.length) orFilters.push({ id: { in: rule.recipientUserIds } });
  if (rule.recipientRoles?.length) {
    orFilters.push({ role: { in: rule.recipientRoles.filter((k) => TIERS.includes(k)) } });
    orFilters.push({ assignedRole: { key: { in: rule.recipientRoles } } });
  }
  if (rule.recipientGroupId) {
    orFilters.push({ groupMemberships: { some: { groupId: rule.recipientGroupId } } });
  }
  // An escalation is what happens when the normal recipients have not acted,
  // so it adds the escalation group rather than replacing them. Until now
  // `escalateToGroupId` was stored, validated and returned by the API but
  // never read here, so escalations went only to the usual people — which is
  // to say, escalating did nothing at all.
  if (escalating && rule.escalateToGroupId) {
    orFilters.push({ groupMemberships: { some: { groupId: rule.escalateToGroupId } } });
  }
  if (orFilters.length === 0) return [];

  return prisma.user.findMany({
    // Alerts are sent to people, and a service account's address is
    // deliberately undeliverable.
    where: { orgId, status: 'active', deletedAt: null, kind: 'human', OR: orFilters },
    select: { id: true, name: true, email: true, role: true, accessScope: true },
  });
}

/**
 * Drop recipients who cannot see the server. A scoped user must not learn
 * that an out-of-scope server exists — least of all through an alert.
 */
export async function filterByScope(recipients, server) {
  const allowed = [];
  for (const user of recipients) {
    const scope = await resolveScope(user);
    if (isUnscoped(scope) || scope.customerIds.includes(server.customerId)) allowed.push(user);
  }
  return allowed;
}

/** True when this (finding, rule) pair already fired inside the throttle window. */
async function throttled(rule, findingKey) {
  if (!rule.throttleMinutes || rule.throttleMinutes <= 0) return false;
  const key = `${THROTTLE_PREFIX}${rule.id}:${findingKey}`;
  // SET NX EX — the set itself is the claim, so two ingests racing can only
  // produce one notification.
  const claimed = await redis.set(key, '1', 'EX', rule.throttleMinutes * 60, 'NX');
  return claimed === null;
}

function describe(event, server) {
  const { finding } = event;
  const where = `${finding.proto || ''}${finding.port ? `/${finding.port}` : ''}`.trim();
  const host = server.displayName || server.hostname;
  const lead =
    event.type === 'resolved'
      ? 'Resolved'
      : event.type === 'severity_increased'
        ? `Escalated (${event.from} → ${finding.severity})`
        : event.type === 'escalation'
          ? 'Still open'
          : 'New';
  return {
    title: `${lead}: ${finding.code}${where ? ` ${where}` : ''} on ${host}`,
    body: finding.message,
  };
}

/**
 * Route finding transitions to the people the org's rules name.
 *
 * Called after ingest commits. Never throws into its caller — alerting must
 * not be able to fail an ingest (postureService catches, but this is
 * defensive at both ends).
 *
 * @param {{orgId: string, serverId: string, events: Array<{type: string, finding: object, from?: string}>}} params
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function dispatchFindingEvents({ orgId, serverId, events }) {
  const result = { sent: 0, skipped: 0 };
  if (!orgId || !serverId || !events?.length) return result;

  const [server, rules] = await Promise.all([
    prisma.server.findFirst({
      where: { id: serverId, orgId },
      select: { id: true, hostname: true, displayName: true, environment: true, customerId: true },
    }),
    prisma.postureAlertRule.findMany({ where: { orgId, isActive: true } }),
  ]);
  if (!server || rules.length === 0) return result;

  // Muted findings notify nobody (spec §6 rule 2). Look up the stored rows
  // once — the events carry computed findings, not their persisted mute state.
  const stored = await prisma.exposureFinding.findMany({
    where: { orgId, serverId },
    select: { code: true, proto: true, port: true, mutedUntil: true },
  });
  const now = new Date();
  const mutedKeys = new Set(
    stored
      .filter((f) => f.mutedUntil && f.mutedUntil > now)
      .map((f) => `${f.code}::${f.proto ?? ''}::${f.port ?? ''}`)
  );

  for (const event of events) {
    const { finding } = event;
    const findingKey = `${finding.code}::${finding.proto ?? ''}::${finding.port ?? ''}`;
    if (mutedKeys.has(findingKey)) {
      result.skipped += 1;
      continue;
    }

    for (const rule of rules) {
      if (!ruleWantsEvent(rule, event.type)) continue;
      if (!ruleMatches(rule, { finding, server })) continue;
      if (await throttled(rule, `${serverId}:${findingKey}`)) {
        result.skipped += 1;
        continue;
      }

      const recipients = await filterByScope(
        await resolveRecipients(orgId, rule, { escalating: event.type === 'escalation' }),
        server
      );
      const { title, body } = describe(event, server);

      // Chat is per-rule, like the other channels, and per-FINDING rather
      // than per-recipient: several rules matching one finding would
      // otherwise put the same message in a channel several times.
      if (rule.channels?.includes('chat')) {
        await notifyEvent({
          orgId,
          event: 'posture.finding',
          recipients: [],
          title,
          body,
          chat: {
            fields: [
              { label: 'Server', value: server.displayName || server.hostname },
              { label: 'Environment', value: server.environment },
              { label: 'Severity', value: String(finding.severity || '').toLowerCase() },
              { label: 'Finding', value: finding.code },
              ...(finding.port ? [{ label: 'Port', value: `${finding.proto || 'tcp'}/${finding.port}` }] : []),
              { label: 'Rule', value: rule.name },
            ],
            url: `${config.frontendUrl}/servers/${serverId}`,
            context: { environment: server.environment, customerId: server.customerId },
          },
        });
      }

      for (const user of recipients) {
        if (rule.channels?.includes('inapp')) {
          try {
            await notificationService.create({
              orgId,
              userId: user.id,
              type: 'POSTURE_FINDING',
              title,
              body,
              metadata: {
                serverId,
                code: finding.code,
                severity: finding.severity,
                proto: finding.proto ?? null,
                port: finding.port ?? null,
                ruleId: rule.id,
                event: event.type,
              },
            });
            result.sent += 1;
          } catch (err) {
            logger.warn('postureAlertService: in-app notification failed', {
              userId: user.id,
              error: err.message,
            });
          }
        }

        // `digest` batches this branch — and ONLY this branch. The in-app row
        // above and the chat message further up still go out per finding, so
        // a digest rule always delivers something immediately. That is the
        // whole lesson of the first attempt: digest mode suppressed the only
        // channel a rule had and deferred to a job nobody had written, so
        // those rules delivered nothing, ever, and said nothing about it.
        // jobs/postureDigest.js is that job; it selects on `lastDigestAt`,
        // which is why nothing here has to remember what it skipped.
        if (rule.channels?.includes('email') && rule.mode !== 'digest') {
          try {
            await mailer.sendMail({
              orgId,
              to: user.email,
              subject: `[Shellius] ${title}`,
              text: `${body}\n\nServer: ${server.displayName || server.hostname} (${server.environment})\nRule: ${rule.name}`,
              // Every interpolated value here originates on the host (finding
              // messages carry process names and unix users) or in org input.
              // A compromised host must not be able to inject markup into an
              // admin's mailbox — spec §9.12, "escaping at render".
              html: `<p>${esc(body)}</p><p><strong>Server:</strong> ${esc(
                server.displayName || server.hostname
              )} (${esc(server.environment)})<br/><strong>Rule:</strong> ${esc(rule.name)}</p>`,
            });
          } catch (err) {
            // Email being down must not lose the in-app notification above.
            logger.warn('postureAlertService: alert email failed', {
              userId: user.id,
              error: err.message,
            });
          }
        }
      }
    }
  }

  return result;
}

/**
 * Seed the quiet default so a fresh org is useful without being noisy:
 * CRITICAL only, to admins, in-app + email, immediate, no escalation.
 * Editable and deletable like any other rule.
 */
export async function ensureDefaultAlertRule(orgId) {
  const existing = await prisma.postureAlertRule.count({ where: { orgId } });
  if (existing > 0) return null;
  return prisma.postureAlertRule.create({
    data: {
      orgId,
      name: 'Critical exposure',
      severities: ['CRITICAL'],
      recipientRoles: ['admin', 'super_admin'],
      channels: ['inapp', 'email'],
      mode: 'immediate',
    },
  });
}

export default {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  dispatchFindingEvents,
  ensureDefaultAlertRule,
  ruleMatches,
};
