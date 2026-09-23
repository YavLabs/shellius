/**
 * chatNotify.js — delivering queued chat messages.
 *
 * Unlike the audit export worker this is not a repeating sweep: each message
 * is its own job, queued the moment the event happened, because a notification
 * that arrives a minute late has largely missed its point.
 *
 * `attempts: 1` is set on every job rather than inherited. The queue's
 * default is three, and BullMQ will re-run a job whose process died after the
 * work succeeded — which for chat means posting the same approval request into a
 * channel twice. A notification is a notice, not a record: losing one to an
 * outage is a smaller harm than duplicating it, which is the opposite of the
 * call the audit sinks make and the reason they are at-least-once while this
 * is at-most-once. Retries that are *known* to be safe — the destination said
 * "rate limited", nothing was posted — are re-queued by hand below.
 */

import prisma from '../config/db.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import { getAdapter } from '../services/notify/chat/index.js';
import {
  decryptConfig,
  recordFailure,
  recordSuccess,
  DELIVERY_RETENTION_DAYS,
} from '../services/notify/chatDestinationService.js';

const QUEUE_NAME = 'chat-notify';
/** How many times we re-queue a message the destination told us to retry. */
const MAX_SOFT_RETRIES = 3;

export const chatNotifyQueue = createQueue(QUEUE_NAME);

export async function registerChatNotifyJob() {
  // Nothing repeating to register — jobs are queued per message. The prune
  // below is the only scheduled part.
  try {
    const repeatables = await chatNotifyQueue.getRepeatableJobs();
    for (const r of repeatables) await chatNotifyQueue.removeRepeatableByKey(r.key);
    await chatNotifyQueue.add('prune', {}, { repeat: { every: 24 * 60 * 60 * 1000 } });
    logger.info('chatNotify: queue registered (daily prune)');
  } catch (err) {
    logger.error('chatNotify: failed to register job', { error: err.message });
  }
}

/** Delivery rows are diagnostics, not records. Keep a month. */
export async function pruneDeliveries() {
  const cutoff = new Date(Date.now() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatDelivery.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count) logger.info('chatNotify: pruned old deliveries', { count });
  return count;
}

/**
 * Deliver one message.
 *
 * @param {object} ctx.adapter - overrides the registry; the seam the tests
 *   drive, since ESM namespace objects are frozen and cannot be patched.
 */
export async function deliverOne({ deliveryId, message, attempt = 0 }, ctx = {}) {
  const delivery = await prisma.chatDelivery.findUnique({
    where: { id: deliveryId },
    include: { destination: true },
  });
  if (!delivery) return { skipped: 'delivery row is gone' };
  if (delivery.status === 'delivered') return { skipped: 'already delivered' };

  const row = delivery.destination;
  if (!row || !row.isActive) {
    await prisma.chatDelivery.update({
      where: { id: deliveryId },
      data: { status: 'dropped', error: 'Destination is switched off' },
    });
    return { skipped: 'destination inactive' };
  }

  const adapter = ctx.adapter ?? getAdapter(row.platform);
  const startedAt = Date.now();

  try {
    const result = await adapter.deliver(decryptConfig(row), message, { event: delivery.event });
    await prisma.chatDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'delivered',
        attempt: attempt + 1,
        deliveredAt: new Date(),
        durationMs: Date.now() - startedAt,
        channel: result?.channel ?? null,
        messageTs: result?.ts ?? null,
        error: null,
      },
    });
    await recordSuccess(row.id);
    return { delivered: true };
  } catch (err) {
    const retryable = err?.retryable === true && attempt + 1 < MAX_SOFT_RETRIES;
    await prisma.chatDelivery.update({
      where: { id: deliveryId },
      data: {
        status: retryable ? 'queued' : 'failed',
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: err.message?.slice(0, 2000) ?? null,
      },
    });
    await recordFailure(row, err);

    if (retryable) {
      // The destination told us it did not accept the message, so re-sending
      // cannot duplicate it.
      const delay = err.retryAfterMs ?? 5000 * 2 ** attempt;
      await chatNotifyQueue.add(
        'deliver',
        { deliveryId, message, attempt: attempt + 1 },
        { delay, attempts: 1, jobId: `chat-${deliveryId}-${attempt + 1}` }
      );
      return { retrying: true, delay };
    }

    logger.warn('chatNotify: delivery failed', {
      deliveryId,
      destinationId: row.id,
      platform: row.platform,
      error: err.message,
    });
    return { failed: true };
  }
}

export function startChatNotifyWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async (job) => {
      if (job.name === 'prune') return pruneDeliveries();
      return deliverOne(job.data);
    });

    worker.on('failed', (job, err) => {
      logger.error(`chatNotify: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('chatNotify: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('chatNotify: failed to start worker', { error: err.message });
    return null;
  }
}

export default { chatNotifyQueue, registerChatNotifyJob, startChatNotifyWorker, deliverOne, pruneDeliveries };
