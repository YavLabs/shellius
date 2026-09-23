/**
 * chatIdentityService.js — binding a chat account to a Shellius user.
 *
 * Required before anybody may act on anything from chat. The shape follows
 * `ssoLinkService`: a short-lived pending record in Redis, consumed exactly
 * once, confirmed from inside Shellius under a real session.
 *
 * ## Why not match on email
 *
 * Because a Slack workspace administrator can set a member's email address. If
 * a matching address were enough to bind an identity, that administrator could
 * make themselves any Shellius approver they liked and approve production
 * access as that person. Email is fine for deciding where to send a direct
 * message — the harm of a misdirected DM is disclosure, not escalation — but
 * it can never authorise a decision, and `linkedVia` records which happened.
 *
 * ## Why link-on-first-use
 *
 * The binding needs proof of control of both accounts. Pressing the button
 * proves the Slack side; completing the link while signed in to Shellius
 * proves the other. Neither half is useful alone, and nobody has to maintain
 * a mapping table by hand.
 */

import crypto from 'crypto';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { ACTIONS, log as auditLog } from '../auditService.js';

const PENDING_PREFIX = 'chat:link:';
/** Long enough to switch to a browser and sign in, short enough to matter. */
export const PENDING_TTL_SEC = 15 * 60;

const pendingKey = (token) => `${PENDING_PREFIX}${token}`;

/**
 * Remember that this chat account asked to be linked, and return the token
 * that will complete it. Called when an unlinked account presses a button.
 */
export async function startLink({ orgId, platform, workspaceId, externalUserId, displayName = null }) {
  const token = crypto.randomBytes(32).toString('hex');
  await redis.set(
    pendingKey(token),
    JSON.stringify({ orgId, platform, workspaceId, externalUserId, displayName, createdAt: Date.now() }),
    'EX',
    PENDING_TTL_SEC
  );
  return { token, expiresInSeconds: PENDING_TTL_SEC };
}

/** Read a pending link without consuming it, so a page can describe it. */
export async function peekLink(token) {
  const raw = await redis.get(pendingKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Complete a link. Called from an authenticated Shellius session, so `userId`
 * is proven — the token only supplies the chat side.
 */
export async function completeLink(token, { userId, orgId, ipAddress = null }) {
  const raw = await redis.get(pendingKey(token));
  if (!raw) throw new ApiError(410, 'That link request has expired. Press the button in chat again.');
  // Delete first: whoever wins the race gets the binding, and a replay finds
  // nothing. Same rule ssoLinkService uses.
  await redis.del(pendingKey(token));

  const pending = JSON.parse(raw);
  if (pending.orgId !== orgId) {
    // The pending record names the organisation whose destination produced the
    // button. Completing it from another org would bind an identity across a
    // tenant boundary.
    throw new ApiError(403, 'That link request belongs to a different organization');
  }

  const existing = await prisma.chatIdentity.findFirst({
    where: {
      orgId,
      platform: pending.platform,
      workspaceId: pending.workspaceId,
      externalUserId: pending.externalUserId,
    },
  });
  if (existing && existing.userId !== userId) {
    throw new ApiError(409, 'That chat account is already linked to another Shellius user');
  }

  const identity = existing
    ? existing
    : await prisma.chatIdentity.create({
        data: {
          orgId,
          userId,
          platform: pending.platform,
          workspaceId: pending.workspaceId,
          externalUserId: pending.externalUserId,
          linkedVia: 'confirmed',
          linkedByIp: ipAddress,
        },
      });

  await auditLog({
    orgId,
    actorId: userId,
    action: ACTIONS.chat_identity.linked,
    resourceType: 'ChatIdentity',
    resourceId: identity.id,
    metadata: { platform: pending.platform, workspaceId: pending.workspaceId, via: 'confirmed' },
    ipAddress,
  });

  return identity;
}

/**
 * The Shellius user behind a chat account, for THIS organization.
 *
 * Scoped by org deliberately: two organizations may share one Slack
 * workspace, and a globally unique mapping would let a button pressed in one
 * resolve to a user in the other.
 */
export async function resolveUser({ orgId, platform, workspaceId, externalUserId }) {
  const identity = await prisma.chatIdentity.findFirst({
    where: { orgId, platform, workspaceId, externalUserId },
    include: {
      user: { select: { id: true, orgId: true, name: true, email: true, status: true, deletedAt: true, kind: true } },
    },
  });
  if (!identity) return null;
  // Only an explicitly confirmed binding may authorise anything.
  if (identity.linkedVia !== 'confirmed') return null;
  const user = identity.user;
  if (!user || user.deletedAt || user.status !== 'active' || user.kind !== 'human') return null;
  if (user.orgId !== orgId) return null;

  prisma.chatIdentity
    .update({ where: { id: identity.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => logger.debug('chatIdentityService: lastUsedAt update failed', { error: err.message }));

  return { identity, user };
}

export async function listForUser(userId) {
  return prisma.chatIdentity.findMany({
    where: { userId },
    orderBy: { linkedAt: 'desc' },
    select: { id: true, platform: true, workspaceId: true, externalUserId: true, linkedAt: true, lastUsedAt: true },
  });
}

export async function unlink(orgId, userId, id, actor = null) {
  const identity = await prisma.chatIdentity.findFirst({ where: { id, orgId, userId } });
  if (!identity) throw new ApiError(404, 'Chat account not found');
  await prisma.chatIdentity.delete({ where: { id } });
  await auditLog({
    orgId,
    actorId: actor?.userId ?? userId,
    action: ACTIONS.chat_identity.unlinked,
    resourceType: 'ChatIdentity',
    resourceId: id,
    metadata: { platform: identity.platform, workspaceId: identity.workspaceId },
  });
  return { id };
}

export default {
  startLink,
  peekLink,
  completeLink,
  resolveUser,
  listForUser,
  unlink,
  PENDING_TTL_SEC,
};
