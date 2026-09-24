/**
 * postureDigestService.js — build and send the periodic posture digest.
 *
 * The counterpart to postureAlertService's immediate dispatch. A rule in
 * `mode: 'digest'` still writes its in-app rows and chat messages per finding;
 * only the EMAIL channel is batched here. That asymmetry is deliberate and is
 * the whole reason this feature was withdrawn once already: the first version
 * suppressed the only channel a rule had and deferred to a job that did not
 * exist, so those rules delivered nothing at all, silently, for as long as
 * they were configured that way.
 *
 * The shape that matters: a digest is assembled PER RECIPIENT, not per rule.
 * Two people named by the same rule can be scoped to different customers
 * (`User.accessScope`), and a scoped user must never learn that an
 * out-of-scope server exists — least of all through a summary email. One
 * rendered email shared between them would leak exactly that.
 */

import prisma from '../config/db.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { resolveScope, isUnscoped } from '../lib/scope.js';
import { renderTemplate } from '../email/index.js';
import * as mailer from './mailer.js';
import { resolveRecipients, filterByScope, ruleMatches } from './postureAlertService.js';
import { digestDue, periodLabel } from './digestSchedule.js';

/**
 * Hard ceiling on findings carried in one email. A host that has just had its
 * firewall turned off can produce hundreds of findings in a single scan; the
 * digest names the worst of them and points at Shellius for the rest.
 */
export const MAX_DIGEST_FINDINGS = Number(process.env.POSTURE_DIGEST_MAX_FINDINGS || 100);

/** Worst first, so truncation drops the least important rows. */
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const rank = (s) => SEVERITY_RANK[String(s || '').toUpperCase()] ?? 5;

const FINDING_SELECT = {
  id: true,
  code: true,
  severity: true,
  proto: true,
  port: true,
  message: true,
  firstSeenAt: true,
  resolvedAt: true,
  serverId: true,
  server: {
    select: { id: true, hostname: true, displayName: true, environment: true, customerId: true },
  },
};

/** Flatten a finding row into what the template renders. */
function toRow(f) {
  return {
    id: f.id,
    severity: f.severity,
    code: f.code,
    proto: f.proto,
    port: f.port,
    message: f.message,
    serverName: f.server?.displayName || f.server?.hostname || '',
    environment: f.server?.environment || '',
    customerId: f.server?.customerId || null,
  };
}

/**
 * Findings this rule would have mailed about during the window.
 *
 * The rule's own filters are pushed into the query where they can be, and
 * `ruleMatches` is still applied afterwards — it is the authority on what a
 * rule covers, and duplicating its logic in SQL is how the two drift apart.
 */
export async function findingsForWindow(rule, { from, to, now = new Date() }) {
  const serverWhere = {};
  if (rule.customerIds?.length) serverWhere.customerId = { in: rule.customerIds };
  if (rule.environments?.length) serverWhere.environment = { in: rule.environments };

  const base = {
    orgId: rule.orgId,
    ...(rule.severities?.length ? { severity: { in: rule.severities } } : {}),
    ...(rule.codes?.length ? { code: { in: rule.codes } } : {}),
    ...(Object.keys(serverWhere).length ? { server: serverWhere } : {}),
    // A muted finding is one somebody has already decided about.
    // `lte`, not `lt`: postureAlertService's immediate path treats
    // `mutedUntil > now` as muted, so a finding whose mute expires on this
    // exact millisecond is NOT muted there. The two checks are meant to be
    // the same rule and disagreed at the boundary.
    OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }],
  };

  // Opened (or reopened — ingest resets firstSeenAt on both) inside the
  // window and still open. Acknowledged findings are left out: somebody has
  // already picked them up, which is what the immediate alert was for.
  const openedWhere = { ...base, resolvedAt: null, acknowledgedAt: null, firstSeenAt: { gte: from, lt: to } };
  const opened = await prisma.exposureFinding.findMany({
    where: openedWhere,
    select: FINDING_SELECT,
    // ORDERED, and that matters more than the cap itself. Without an
    // orderBy the database may return any N of the matching rows, so one
    // noisy customer could consume the whole cap and a different customer's
    // scoped recipient would be told "nothing new opened in this period" —
    // a wrong digest rather than a truncated one. Newest first, so what is
    // dropped is the oldest of a very large burst.
    orderBy: [{ firstSeenAt: 'desc' }],
    // A generous cap before per-recipient scoping; the per-email cap is
    // applied after, so a scoped recipient still gets a full list of their own.
    take: MAX_DIGEST_FINDINGS * 10,
  });

  // Silence is the failure mode this feature exists to eliminate, so a cap
  // that actually bit is said out loud rather than inferred from a count.
  if (opened.length === MAX_DIGEST_FINDINGS * 10) {
    const total = await prisma.exposureFinding.count({ where: openedWhere });
    if (total > opened.length) {
      logger.warn('postureDigest: window exceeded the collection cap; the oldest findings are not included', {
        ruleId: rule.id,
        orgId: rule.orgId,
        matched: total,
        collected: opened.length,
      });
    }
  }

  const resolved = rule.notifyOnResolve
    ? await prisma.exposureFinding.findMany({
        where: { ...base, resolvedAt: { gte: from, lt: to } },
        select: FINDING_SELECT,
        orderBy: [{ resolvedAt: 'desc' }],
        take: MAX_DIGEST_FINDINGS * 10,
      })
    : [];

  const keep = (rows) =>
    rows.filter((f) => f.server && ruleMatches(rule, { finding: f, server: f.server })).map(toRow);

  return { opened: keep(opened), resolved: keep(resolved) };
}

/** Sort worst-first, then cap, reporting how many were left out. */
function capped(rows) {
  const sorted = [...rows].sort((a, b) => rank(a.severity) - rank(b.severity));
  return {
    shown: sorted.slice(0, MAX_DIGEST_FINDINGS),
    truncated: Math.max(0, sorted.length - MAX_DIGEST_FINDINGS),
  };
}

/**
 * Send one rule's digest for one window.
 *
 * Does not decide whether the rule is due and does not move the watermark —
 * the caller owns both, so that a send failure cannot silently skip a period.
 *
 * `sendMail` is injectable for the same reason the audit sinks take
 * `ctx.adapter` and the directory adapters take `fetchImpl`: ESM namespace
 * objects are frozen, so a test cannot replace `mailer.sendMail` in place.
 *
 * @returns {Promise<{sent: number, recipients: number, findings: number, skipped: string[]}>}
 */
export async function sendDigest(rule, { from, to, now = new Date(), sendMail = mailer.sendMail } = {}) {
  const result = { sent: 0, recipients: 0, findings: 0, scopedOut: 0, skipped: [] };

  if (!rule.channels?.includes('email')) {
    // A digest rule with no email channel is not an error: its in-app and
    // chat deliveries already went out per finding, immediately.
    result.skipped.push('no email channel');
    return result;
  }

  const { opened, resolved } = await findingsForWindow(rule, { from, to, now });
  result.findings = opened.length;

  // Nothing happened. Saying so every morning is how a digest gets filtered
  // into a folder and stops being read, so it is not sent.
  if (opened.length === 0 && resolved.length === 0) return result;

  const recipients = await resolveRecipients(rule.orgId, rule);
  result.recipients = recipients.length;
  if (recipients.length === 0) {
    result.skipped.push('no recipients');
    return result;
  }

  const period = periodLabel(from, to);
  const postureUrl = `${config.frontendUrl}/posture`;

  for (const user of recipients) {
    if (!user.email) {
      result.skipped.push(`${user.id}: no address`);
      continue;
    }

    // One scope resolution per recipient, not per (recipient, finding).
    let scope;
    try {
      scope = await resolveScope(user);
    } catch (err) {
      logger.warn('postureDigest: could not resolve scope, skipping recipient', {
        ruleId: rule.id,
        userId: user.id,
        error: err.message,
      });
      continue;
    }
    const visible = (rows) =>
      isUnscoped(scope) ? rows : rows.filter((r) => r.customerId && scope.customerIds.includes(r.customerId));

    const mine = visible(opened);
    const mineResolved = visible(resolved);
    if (mine.length === 0 && mineResolved.length === 0) {
      // Recorded, not just skipped. A rule that matches real findings but
      // whose every recipient is scoped away from them delivers nothing, for
      // ever — which is the precise shape of the bug this whole feature was
      // rebuilt to eliminate, one layer further down. The caller reports it.
      result.scopedOut += 1;
      result.skipped.push(`${user.id}: nothing visible in their customer scope`);
      continue;
    }

    try {
      // Rendering is INSIDE the try. It was outside, which meant a template
      // fault on recipient three rejected the whole call after recipients one
      // and two had already been mailed — and because the job deliberately
      // does not advance the watermark on a throw, the next tick re-sent the
      // same window to all of them.
      const { shown, truncated } = capped(mine);
      const rendered = renderTemplate('postureDigest', {
        recipientName: user.name || user.email,
        ruleName: rule.name,
        periodLabel: period,
        findings: shown,
        resolved: capped(mineResolved).shown,
        truncated,
        postureUrl,
      });

      await sendMail({
        orgId: rule.orgId,
        to: user.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      result.sent += 1;
    } catch (err) {
      // One undeliverable address must not cost everybody else their digest.
      logger.warn('postureDigest: could not send to a recipient', {
        ruleId: rule.id,
        userId: user.id,
        error: err.message,
      });
      result.skipped.push(`${user.id}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Is this rule due, and for what window?
 *
 * The anchor is `lastDigestAt`, falling back to `createdAt` — never to the
 * beginning of time. A rule created this morning must not mail out every
 * finding the organization has ever recorded.
 */
export function dueWindow(rule, now = new Date()) {
  return digestDue(
    { schedule: rule.digestSchedule, hour: rule.digestHour, dayOfWeek: rule.digestDayOfWeek },
    { anchor: rule.lastDigestAt ?? rule.createdAt, now }
  );
}

export default { MAX_DIGEST_FINDINGS, findingsForWindow, sendDigest, dueWindow };
