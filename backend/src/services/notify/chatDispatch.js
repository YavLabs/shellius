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
import { canAct } from './chat/index.js';
import { chatApprovalsAllowProd } from '../orgService.js';

/** Bound how long we will wait to hand work to the queue. */
const ENQUEUE_TIMEOUT_MS = 2000;

/**
 * Approve / deny buttons for an event that has something to decide.
 *
 * Production is gated on an organization switch that defaults to off. When it
 * is off the message still arrives, carrying its link — the decision is simply
 * made in Shellius. When it is on, the production button carries Slack's own
 * confirmation dialog naming the server, so a press is deliberate rather than
 * a mis-tap in a busy channel.
 */
async function buildActions({ orgId, event, context }) {
  if (event.key !== 'access_request.submitted') return [];
  const requestId = context?.accessRequestId;
  if (!requestId) return [];

  const isProd = context.environment === 'prod';
  if (isProd && !(await chatApprovalsAllowProd(orgId))) return [];

  return [
    {
      id: 'approve_request',
      label: 'Approve',
      value: `approve:${requestId}`,
      style: 'primary',
      ...(isProd
        ? {
            confirm: {
              title: 'Approve production access?',
              text: `This grants access to ${context.serverName || 'a production server'} immediately.`,
              ok: 'Approve',
              danger: true,
            },
          }
        : {}),
    },
    { id: 'deny_request', label: 'Deny', value: `deny:${requestId}`, style: 'danger' },
  ];
}

/**
 * Fan one event out to every destination that wants it.
 *
 * @returns {Promise<boolean>} true when at least one delivery was queued
 */
export async function dispatchChatEvent({ orgId, event, title, summary, fields, url, context }) {
  const destinations = await destinationsFor(orgId, event, context);
  if (!destinations.length) return false;

  const message = { title, summary, fields, url, severity: event.severity };

  // Buttons, where the destination can carry them at all. Only Slack in app
  // mode can: a webhook cannot receive the press, and neither Google Chat
  // webhooks nor Teams workflow webhooks have an interaction callback.
  const actions = await buildActions({ orgId, event, context });

  const queued = [];
  for (const { row } of destinations) {
    const withActions = canAct(row.platform, row.mode) ? actions : [];
    try {
      const delivery = await prisma.chatDelivery.create({
        data: { orgId, destinationId: row.id, event: event.key, status: 'queued' },
      });
      queued.push({ id: delivery.id, actions: withActions });
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
      queued.map(({ id, actions: a }) =>
        // attempts: 1 — see jobs/chatNotify.js. A BullMQ retry after a
        // successful post would put the same message in the channel twice.
        chatNotifyQueue.add('deliver', { deliveryId: id, message, actions: a }, { attempts: 1, jobId: `chat-${id}` })
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
        where: { id: { in: queued.map((q) => q.id) }, status: 'queued' },
        data: { status: 'dropped', error: `Not queued: ${err.message}` },
      })
      .catch(() => {});
  });

  return true;
}

export default { dispatchChatEvent };
