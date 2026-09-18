/**
 * wsTicketService.js
 *
 * Single-use, short-lived (30s) tickets that stand in for the access JWT on
 * WebSocket upgrade URLs (`/api/terminal/ssh?t=<ticket>&cols&rows`).
 *
 * Why: a bearer JWT (or the Quick Connect ticket, or an access-request id)
 * in a WebSocket URL query string is logged by reverse proxies (default
 * nginx access logs include $request/$args), unlike an Authorization header.
 * A ws-ticket is minted by an authenticated REST call (the JWT never leaves
 * the header), is bound to (userId, orgId, purpose, params), is GETDEL'd on
 * first use (single-use), and expires in 30s — so even a captured ticket in
 * a proxy log is worthless almost immediately and only ever usable once.
 *
 * Never logged. Never persisted outside Redis's own TTL'd storage.
 */

import crypto from 'crypto';
import redis from '../config/redis.js';
import ApiError from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export const TICKET_TTL_SECONDS = 30;

const REDIS_PREFIX = 'ws:ticket:';

/**
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.orgId
 * @param {'ssh'|'rdp'} params.purpose
 * @param {object} params.params - the intended connect params for this purpose,
 *   e.g. { requestId, principal? } | { ticket } | { attach: sessionId } (ssh)
 * @returns {Promise<{ ticket: string, expiresIn: number }>}
 */
export async function issue({ userId, orgId, purpose, params }) {
  if (!userId || !orgId) throw new ApiError(400, 'userId and orgId are required');
  if (!['ssh', 'rdp'].includes(purpose)) throw new ApiError(400, "purpose must be 'ssh' or 'rdp'");

  const ticket = crypto.randomBytes(32).toString('base64url');
  const payload = { userId, orgId, purpose, params: params || {}, issuedAt: Date.now() };
  await redis.set(REDIS_PREFIX + ticket, encrypt(JSON.stringify(payload)), 'EX', TICKET_TTL_SECONDS);
  return { ticket, expiresIn: TICKET_TTL_SECONDS };
}

/**
 * Consume (GETDEL) a ws-ticket. Throws ApiError(401) if missing, expired,
 * already used, or minted for a different purpose than expected.
 *
 * @param {string} ticket
 * @param {'ssh'|'rdp'} [expectedPurpose]
 * @returns {Promise<{ userId: string, orgId: string, purpose: string, params: object }>}
 */
export async function consume(ticket, expectedPurpose) {
  if (!ticket || typeof ticket !== 'string') {
    throw new ApiError(401, 'Invalid or expired connection ticket');
  }

  const raw = await redis.getdel(REDIS_PREFIX + ticket);
  if (!raw) throw new ApiError(401, 'Invalid or expired connection ticket');

  let payload;
  try {
    payload = JSON.parse(decrypt(raw));
  } catch {
    throw new ApiError(401, 'Invalid or expired connection ticket');
  }

  if (expectedPurpose && payload.purpose !== expectedPurpose) {
    throw new ApiError(401, 'Invalid or expired connection ticket');
  }

  return payload;
}

export default { issue, consume, TICKET_TTL_SECONDS };
