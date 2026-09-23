/**
 * POST /api/chat/slack/interactions — somebody pressed a button in Slack.
 *
 * This is the only route in Shellius that can approve production access
 * without a browser session, so every step is written to fail closed.
 *
 * ## What authenticates the request
 *
 * Not a JWT — Slack has none. Three independent things must hold:
 *
 *   1. the request is signed by our app's signing secret, within five minutes
 *      (see chat/slackSignature.js, and note that a missing raw body is a
 *      refusal, never a skip);
 *   2. the Slack account maps to a Shellius user through an **explicitly
 *      confirmed** ChatIdentity in the organization that owns the destination;
 *   3. that user passes every check the web UI would apply, because the button
 *      calls the same `accessRequestService.review()` — approver-set
 *      membership, an active account, the policy's duration cap, the audit
 *      entry. The chat layer decides nothing on its own.
 *
 * ## Why it answers immediately
 *
 * Slack re-sends any interaction it has not had a response to within three
 * seconds, and each retry is separately signed and entirely valid. So the
 * route acknowledges first and does the work after, and takes a Redis claim
 * on the interaction so a retry cannot act twice. `review()` is also
 * conditional on the request still being PENDING, which is the backstop.
 *
 * ## Production
 *
 * Production may be approved from Slack — a deliberate choice. It is worth
 * being precise about what that does and does not weaken: there is no MFA gate
 * on approval in the web UI either, and the emailed approval link is weaker
 * still for non-production. What a chat message adds is visibility to a whole
 * channel and a button with no typed confirmation, so production presses open
 * a modal requiring a justification, the org switch defaults to off, and the
 * audit entry records `via: 'slack'` with the Slack user and team.
 */

import express from 'express';
import redis from '../config/redis.js';
import prisma from '../config/db.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import * as accessRequestService from '../services/accessRequestService.js';
import * as chatIdentityService from '../services/notify/chatIdentityService.js';
import { decryptConfig } from '../services/notify/chatDestinationService.js';
import { verifySlackSignature } from '../services/notify/chat/slackSignature.js';
import { ACTIONS, log as auditLog } from '../services/auditService.js';
import { chatApprovalsAllowProd } from '../services/orgService.js';

const router = express.Router();

/** One interaction acts once, however many times Slack re-sends it. */
const CLAIM_TTL_SEC = 300;

/**
 * Slack posts `application/x-www-form-urlencoded` with a single `payload`
 * field. The parser is mounted here, on this path only, and keeps the exact
 * bytes — the signature covers them, and a re-serialised body will not match.
 */
router.use(
  express.urlencoded({
    extended: false,
    limit: '256kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/** Slack shows this to the presser alone. */
const ephemeral = (res, text) => res.json({ response_type: 'ephemeral', replace_original: false, text });

async function claim(key) {
  try {
    return (await redis.set(`chat:claim:${key}`, '1', 'EX', CLAIM_TTL_SEC, 'NX')) === 'OK';
  } catch (err) {
    // Redis down: better to risk the second press being refused by review()'s
    // PENDING check than to refuse every press.
    logger.warn('slackInteractions: claim unavailable', { error: err.message });
    return true;
  }
}

/**
 * Find the destination — and therefore the organization — this button came
 * from. Tenancy is established here, from the workspace, never from the
 * identity row alone.
 */
async function destinationForTeam(teamId) {
  const rows = await prisma.chatDestination.findMany({ where: { platform: 'slack', mode: 'app' } });
  for (const row of rows) {
    const cfg = decryptConfig(row);
    if (cfg.workspaceId && cfg.workspaceId === teamId) return { row, config: cfg };
  }
  // A single-workspace install often has no workspaceId recorded until its
  // first successful test; fall back to the only app-mode destination.
  const appRows = rows.filter((r) => decryptConfig(r).botToken);
  if (appRows.length === 1) return { row: appRows[0], config: decryptConfig(appRows[0]) };
  return null;
}

router.post('/interactions', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body?.payload ?? '{}');
  } catch {
    return res.status(400).json({ error: 'bad payload' });
  }

  const teamId = payload?.team?.id ?? payload?.enterprise?.id ?? null;
  const slackUserId = payload?.user?.id ?? null;
  const action = payload?.actions?.[0] ?? null;
  if (!teamId || !slackUserId || !action) return res.status(400).json({ error: 'incomplete payload' });

  const target = await destinationForTeam(teamId);
  if (!target) {
    logger.warn('slackInteractions: no destination for workspace', { teamId });
    return res.status(401).json({ error: 'unknown workspace' });
  }

  const verified = verifySlackSignature({
    signingSecret: target.config.signingSecret,
    signature: req.get('x-slack-signature'),
    timestamp: req.get('x-slack-request-timestamp'),
    rawBody: req.rawBody,
  });
  if (!verified.ok) {
    logger.warn('slackInteractions: signature rejected', { teamId, reason: verified.reason });
    return res.status(401).json({ error: 'signature verification failed' });
  }

  const orgId = target.row.orgId;
  const resolved = await chatIdentityService.resolveUser({
    orgId,
    platform: 'slack',
    workspaceId: teamId,
    externalUserId: slackUserId,
  });

  if (!resolved) {
    // Not an error — the common first-run case. Offer to link, and do nothing.
    const { token } = await chatIdentityService.startLink({
      orgId,
      platform: 'slack',
      workspaceId: teamId,
      externalUserId: slackUserId,
      displayName: payload?.user?.username ?? null,
    });
    await auditLog({
      orgId,
      action: ACTIONS.chat_identity.unknown_actor,
      resourceType: 'ChatIdentity',
      metadata: { platform: 'slack', workspaceId: teamId, slackUserId, actionId: action.action_id },
    });
    return ephemeral(
      res,
      `This Slack account isn't linked to Shellius yet, so nothing was changed. Link it here and press the button again: ${config.frontendUrl}/chat/link?token=${token}`
    );
  }

  const [verb, requestId] = String(action.value ?? '').split(':');
  if (!['approve', 'deny'].includes(verb) || !requestId) {
    return ephemeral(res, 'That button is no longer valid.');
  }

  // Slack retries anything unanswered within three seconds, each retry
  // separately signed and valid, so the claim — not the signature — is what
  // makes a double press harmless.
  const messageTs = payload?.message?.ts ?? 'none';
  if (!(await claim(`${teamId}:${messageTs}:${action.action_id}:${requestId}`))) {
    return ephemeral(res, 'That was already handled.');
  }

  const request = await prisma.accessRequest.findFirst({
    where: { id: requestId, orgId },
    include: { server: { select: { environment: true, hostname: true, displayName: true } } },
  });
  if (!request) return ephemeral(res, 'That request no longer exists.');

  if (request.server?.environment === 'prod' && verb === 'approve') {
    if (!(await chatApprovalsAllowProd(orgId))) {
      return ephemeral(
        res,
        `Production access is not approved from chat in this organization. Open it in Shellius: ${config.frontendUrl}/access-requests?request=${requestId}`
      );
    }
  }

  try {
    await accessRequestService.review({
      requestId,
      reviewerId: resolved.user.id,
      decision: verb === 'approve' ? 'approve' : 'deny',
      deniedReason: verb === 'deny' ? 'Denied from Slack' : undefined,
      via: 'slack',
    });
  } catch (err) {
    // review() is the authority: not an approver, account suspended, already
    // decided. Report it, change nothing.
    return ephemeral(res, err.statusCode === 409 ? 'That request was already decided.' : `Not done: ${err.message}`);
  }

  const who = resolved.user.name || resolved.user.email;
  const host = request.server?.displayName || request.server?.hostname || 'the server';
  // replace_original retires the message, so the buttons cannot be pressed
  // again by anyone else reading the channel.
  return res.json({
    replace_original: true,
    text: `${verb === 'approve' ? '✅ Approved' : '⛔️ Denied'} — access to ${host}, by ${who}.`,
  });
});

export default router;
