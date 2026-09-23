/**
 * chatDispatch.js — turning one event into queued messages.
 *
 * Called by `notifyEvent` and by nothing else. Its only job is to work out
 * which destinations want this event, write a `ChatDelivery` row for each, and
 * hand them to the worker. It does not talk to any chat platform itself.
 *
 * It is queued rather than sent inline for one specific reason: the caller is
 * usually in the middle of serving a request — somebody submitting an access
 * request, somebody approving one — and a Slack outage must not make that
 * request slow or fail. The enqueue is also deliberately not awaited on that
 * path, because the Redis client is configured with `maxRetriesPerRequest:
 * null`, which means `queue.add()` HANGS rather than rejecting while Redis is
 * down. Awaiting it would hang access-request submission, which is precisely
 * the failure the queue was introduced to avoid.
 */

import prisma from '../../config/db.js';
import logger from '../../utils/logger.js';
import { destinationsFor } from './chatDestinationService.js';

/** Bound how long we will wait to hand work to the queue. */
const ENQUEUE_TIMEOUT_MS = 2000;

/**
 * Fan one event out to every destination that wants it.
 *
 * @returns {Promise<boolean>} true when at least one delivery was queued
 */
export async function dispatchChatEvent({ orgId, event, title, summary, fields, url, context }) {
  const destinations = await destinationsFor(orgId, event, context);
  if (!destinations.length) return false;

  const message = { title, summary, fields, url, severity: event.severity };

  const queued = [];
  for (const { row } of destinations) {
    try {
      const delivery = await prisma.chatDelivery.create({
        data: { orgId, destinationId: row.id, event: event.key, status: 'queued' },
      });
      queued.push(delivery.id);
    } catch (err) {
      logger.warn('chatDispatch: could not record delivery', { destinationId: row.id, error: err.message });
    }
  }
  if (!queued.length) return false;

  // Fire and forget, with a bound. A queue that is unavailable costs us the
  // notification, never the operation that triggered it.
  const enqueue = (async () => {
    const { chatNotifyQueue } = await import('../../jobs/chatNotify.js');
    await Promise.all(
      queued.map((deliveryId) =>
        // attempts: 1 — see jobs/chatNotify.js. A BullMQ retry after a
        // successful post would put the same message in the channel twice.
        chatNotifyQueue.add('deliver', { deliveryId, message }, { attempts: 1, jobId: `chat-${deliveryId}` })
      )
    );
  })();

  Promise.race([
    enqueue,
    new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue timed out')), ENQUEUE_TIMEOUT_MS)),
  ]).catch((err) => {
    logger.warn('chatDispatch: could not queue chat delivery', { orgId, event: event.key, error: err.message });
    prisma.chatDelivery
      .updateMany({
        where: { id: { in: queued }, status: 'queued' },
        data: { status: 'dropped', error: `Not queued: ${err.message}` },
      })
      .catch(() => {});
  });

  return true;
}

export default { dispatchChatEvent };
