/**
 * postureEscalate.js
 *
 * BullMQ repeatable job — runs hourly. Finds exposure findings that are still
 * open past a rule's `escalateAfterHours` and routes them again, to the rule's
 * escalation group where one is set (docs/posture/posture-spec.md §6).
 *
 * Why a job and not part of ingest: escalation is about the passage of TIME,
 * not about a snapshot arriving. A host that stops reporting entirely must
 * still escalate its open findings — if this lived in ingest, the very case
 * you most want escalated (collector dead, problem unfixed) would go silent.
 *
 * Deliberately inert for findings that are muted or acknowledged: mute
 * silences escalations too, and acknowledging is precisely how someone says
 * "I have this, stop paging me" without claiming it is fixed.
 */

import prisma from '../config/db.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import * as postureAlertService from '../services/postureAlertService.js';

const QUEUE_NAME = 'posture-escalate';

export const postureEscalateQueue = createQueue(QUEUE_NAME);

export async function registerPostureEscalateJob() {
  try {
    const repeatables = await postureEscalateQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await postureEscalateQueue.removeRepeatableByKey(r.key);
    }
    await postureEscalateQueue.add('run', {}, { repeat: { every: 60 * 60 * 1000 } });
    logger.info('postureEscalate: repeatable job registered (hourly)');
  } catch (err) {
    logger.error('postureEscalate: failed to register job', { error: err.message });
  }
}

/**
 * One escalation pass. Exported for tests and for a manual run.
 * @returns {Promise<{escalated: number}>}
 */
export async function runEscalationPass() {
  const rules = await prisma.postureAlertRule.findMany({
    where: { isActive: true, escalateAfterHours: { not: null } },
  });
  let escalated = 0;

  for (const rule of rules) {
    const cutoff = new Date(Date.now() - rule.escalateAfterHours * 60 * 60 * 1000);
    const findings = await prisma.exposureFinding.findMany({
      where: {
        orgId: rule.orgId,
        resolvedAt: null,
        acknowledgedAt: null,
        firstSeenAt: { lt: cutoff },
        OR: [{ mutedUntil: null }, { mutedUntil: { lt: new Date() } }],
      },
      take: 200,
    });

    for (const finding of findings) {
      try {
        // Routed through the same dispatcher as a fresh transition, so mute,
        // scope intersection and throttling all behave identically. The
        // throttle is what stops an hourly job from paging hourly forever.
        await postureAlertService.dispatchFindingEvents({
          orgId: rule.orgId,
          serverId: finding.serverId,
          events: [{ type: 'escalation', finding }],
        });
        escalated += 1;
      } catch (err) {
        logger.warn('postureEscalate: dispatch failed', {
          findingId: finding.id,
          error: err.message,
        });
      }
    }
  }

  return { escalated };
}

export function startPostureEscalateWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('postureEscalate: job started');
      const result = await runEscalationPass();
      logger.info('postureEscalate: job finished', result);
      return result;
    });
    worker?.on('failed', (job, err) => {
      logger.error('postureEscalate: job failed', { jobId: job?.id, error: err?.message });
    });
    return worker;
  } catch (err) {
    logger.error('postureEscalate: failed to start worker', { error: err.message });
    return null;
  }
}

export default { registerPostureEscalateJob, startPostureEscalateWorker, runEscalationPass };
