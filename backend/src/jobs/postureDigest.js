/**
 * postureDigest.js
 *
 * BullMQ repeatable job — every 15 minutes. That is a scheduling tick, not a
 * digest interval: each rule carries its own cadence (daily or weekly, at an
 * hour, UTC) and is only sent when that moment has passed since its last
 * digest. A frequent, cheap tick is what lets a rule scheduled for 08:00 be
 * sent at 08:00 rather than whenever a coarse job happens to run.
 *
 * This is the job whose absence made `mode: 'digest'` deliver nothing at all
 * until it was removed in 2.0. Two properties follow from that history and
 * are worth stating plainly:
 *
 *   - The watermark (`lastDigestAt`) moves only after a send is attempted,
 *     and it moves even when the send found nothing. Advancing on an empty
 *     period is what stops the window growing without bound; not advancing
 *     on a failure is what stops a period being skipped in silence.
 *   - A rule that is due but whose send throws leaves the watermark alone, so
 *     the next tick retries the same window. A duplicated digest is a far
 *     better failure than a missing one.
 */

import prisma from '../config/db.js';
import redis from '../config/redis.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import { sendDigest, dueWindow } from '../services/postureDigestService.js';

const QUEUE_NAME = 'posture-digest';
const EVERY_MS = 15 * 60 * 1000;
/** Comfortably longer than a large digest takes to assemble and mail. */
const LOCK_TTL_MS = 10 * 60 * 1000;

export const postureDigestQueue = createQueue(QUEUE_NAME);

export async function registerPostureDigestJob() {
  try {
    const repeatables = await postureDigestQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await postureDigestQueue.removeRepeatableByKey(r.key);
    }
    await postureDigestQueue.add('run', {}, { repeat: { every: EVERY_MS } });
    logger.info('postureDigest: repeatable job registered (every 15m)');
  } catch (err) {
    logger.error('postureDigest: failed to register job', { error: err.message });
  }
}

/**
 * One instance at a time per rule.
 *
 * This deliberately does NOT fail open. Two application instances sending the
 * same rule's digest at once would put the same email in the same inbox
 * twice, and there is no receiver-side dedupe for a human reading their mail.
 * If the lock cannot be taken, the rule waits for the next tick — fifteen
 * minutes late is invisible on a daily digest.
 */
async function withLock(ruleId, fn) {
  const key = `lock:posture-digest:${ruleId}`;
  let held = false;
  try {
    held = (await redis.set(key, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('postureDigest: lock unavailable, skipping this pass', { ruleId, error: err.message });
    return null;
  }
  if (!held) return null;
  try {
    return await fn();
  } finally {
    redis.del(key).catch(() => {});
  }
}

/**
 * Send every digest that is due, across every organization.
 *
 * Exported for tests and for a manual run.
 *
 * @returns {Promise<{considered: number, sent: number, emails: number, failed: number}>}
 */
export async function runDigestPass({ now = new Date(), sendMail } = {}) {
  const rules = await prisma.postureAlertRule.findMany({
    where: { isActive: true, mode: 'digest' },
  });

  const summary = { considered: rules.length, sent: 0, emails: 0, failed: 0, deliveredToNobody: 0 };

  for (const rule of rules) {
    let window;
    try {
      window = dueWindow(rule, now);
    } catch (err) {
      // A malformed cadence on one rule must not stop every other rule.
      logger.warn('postureDigest: could not schedule rule', { ruleId: rule.id, error: err.message });
      summary.failed += 1;
      continue;
    }
    if (!window.due) continue;

    await withLock(rule.id, async () => {
      // Re-read under the lock. The rule may have been edited, switched back
      // to immediate, deactivated or deleted since the list was taken, and
      // another instance may have just sent this very period.
      const fresh = await prisma.postureAlertRule.findUnique({ where: { id: rule.id } });
      if (!fresh || !fresh.isActive || fresh.mode !== 'digest') return;
      const recheck = dueWindow(fresh, now);
      if (!recheck.due) return;

      try {
        const result = await sendDigest(fresh, { from: recheck.from, to: recheck.to, now, ...(sendMail ? { sendMail } : {}) });
        // The watermark moves on success even when nothing was found — an
        // empty period is still a period that has been dealt with.
        await prisma.postureAlertRule.update({
          where: { id: fresh.id },
          data: { lastDigestAt: recheck.to },
        });
        summary.sent += 1;
        summary.emails += result.sent;

        // A rule that matched real findings and mailed nobody is the failure
        // this feature was rebuilt to eliminate, one layer further down: the
        // job is working, the rule is working, and the org hears nothing for
        // ever. Log it as a WARNING naming the cause, not as "digest sent".
        if (result.findings > 0 && result.sent === 0) {
          summary.deliveredToNobody += 1;
          logger.warn('postureDigest: rule matched findings but reached nobody', {
            ruleId: fresh.id,
            orgId: fresh.orgId,
            findings: result.findings,
            recipients: result.recipients,
            scopedOut: result.scopedOut,
            reason:
              result.recipients === 0
                ? 'the rule names no active recipients'
                : result.scopedOut >= result.recipients
                  ? 'every recipient is customer-scoped away from these findings'
                  : 'see skipped',
            skipped: result.skipped.slice(0, 5),
          });
        } else if (result.sent > 0 || result.findings > 0) {
          logger.info('postureDigest: digest sent', {
            ruleId: fresh.id,
            orgId: fresh.orgId,
            findings: result.findings,
            emails: result.sent,
            skipped: result.skipped.length,
          });
        }
      } catch (err) {
        // Watermark untouched on purpose: the next tick retries this window.
        summary.failed += 1;
        logger.error('postureDigest: digest failed, will retry next tick', {
          ruleId: fresh.id,
          orgId: fresh.orgId,
          error: err.message,
        });
      }
    });
  }

  return summary;
}

export function startPostureDigestWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      const summary = await runDigestPass();
      if (summary.sent > 0 || summary.failed > 0) {
        logger.info('postureDigest: pass complete', summary);
      }
      return summary;
    });
    worker.on('failed', (job, err) => {
      logger.error('postureDigest: job failed', { jobId: job?.id, error: err?.message });
    });
    return worker;
  } catch (err) {
    logger.error('postureDigest: failed to start worker', { error: err.message });
    return null;
  }
}

export default { postureDigestQueue, registerPostureDigestJob, runDigestPass, startPostureDigestWorker };
