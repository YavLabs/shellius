/**
 * notifyService.js — the one door through which Shellius tells people things.
 *
 * Before this, every call site wrote an in-app row directly and, at two of
 * them, separately sent an email. Adding a third destination would have meant
 * editing a dozen places and then editing them again for the fourth.
 *
 * `notifyEvent()` takes one event, the people it concerns, and — optionally —
 * how to render it for a channel. It writes the in-app rows exactly as before
 * (once per recipient, through the same `notificationService.create`) and
 * emits the event ONCE to chat. That "once" is the point: five approvers get
 * five bell notifications and a channel gets one message, not five.
 *
 * Two rules worth stating because they are load-bearing:
 *
 * 1. **This never throws.** Callers reach it after the thing being announced
 *    has already happened and been committed — an access request exists, a
 *    decision is made, a certificate is revoked. A notification that fails
 *    must not unwind any of that, and must not stop the caller writing its
 *    audit entry. Everything here is caught and logged.
 *
 * 2. **Nothing is auto-serialised into a chat message.** The chat payload is
 *    built only from the explicit `chat.fields` the call site passes. The
 *    notification's `metadata` is never forwarded wholesale, so a field added
 *    to it later — an id, a URL, a token — cannot quietly start appearing in
 *    somebody's Slack channel. Adding a field to a chat message is a visible
 *    edit at the call site.
 */

import logger from '../../utils/logger.js';
import * as notificationService from '../notificationService.js';
import { getEvent } from '../../config/notificationEvents.js';

/**
 * Announce one event.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.event       - a key from config/notificationEvents.js
 * @param {string[]} [params.recipients] - user ids who hear about it personally
 * @param {string} params.title       - in-app row title
 * @param {string} params.body        - in-app row body
 * @param {object} [params.metadata]  - in-app row metadata (never sent to chat)
 * @param {object} [params.chat]      - omit entirely to skip chat delivery
 * @param {Array<{label: string, value: string}>} [params.chat.fields]
 * @param {string} [params.chat.url]  - where to go to act on this
 * @param {string} [params.chat.title] - overrides the in-app title
 * @param {string} [params.chat.summary] - overrides the in-app body
 * @param {object} [params.chat.context] - `{ environment, customerId }`, used
 *   by a destination's filters. A destination scoped to one customer must not
 *   receive another's, so an event that concerns a customer says so here.
 * @returns {Promise<{ inApp: number, chat: boolean }>}
 */
export async function notifyEvent({
  orgId,
  event,
  recipients = [],
  title,
  body,
  metadata = {},
  chat = null,
}) {
  const result = { inApp: 0, chat: false };
  const definition = getEvent(event);
  if (!definition) {
    // A typo in an event key must not take down the thing being announced.
    logger.error('notifyEvent: unknown event key', { event, orgId });
    return result;
  }

  for (const userId of recipients) {
    if (!userId) continue;
    try {
      await notificationService.create({
        orgId,
        userId,
        type: definition.type,
        title,
        body,
        metadata,
      });
      result.inApp += 1;
    } catch (err) {
      logger.warn('notifyEvent: in-app notification failed', {
        event,
        orgId,
        userId,
        error: err.message,
      });
    }
  }

  if (chat && definition.chatSafe) {
    try {
      // Imported lazily so the chat feature can be absent, disabled or broken
      // without the in-app path above ever noticing.
      const { dispatchChatEvent } = await import('./chatDispatch.js');
      result.chat = await dispatchChatEvent({
        orgId,
        event: definition,
        title: chat.title ?? title,
        summary: chat.summary ?? body,
        fields: chat.fields ?? [],
        url: chat.url ?? null,
        context: chat.context ?? {},
      });
    } catch (err) {
      logger.warn('notifyEvent: chat dispatch failed', { event, orgId, error: err.message });
    }
  }

  return result;
}

export default { notifyEvent };
