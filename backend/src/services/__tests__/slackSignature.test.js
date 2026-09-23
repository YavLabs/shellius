/**
 * Slack signature verification.
 *
 * This is the only thing standing between a stranger on the internet and an
 * approve button, because the interactions endpoint cannot be behind a session
 * — Slack has none. Every test here is a way it could be got around.
 */

import crypto from 'crypto';
import { verifySlackSignature, MAX_SKEW_SECONDS } from '../notify/chat/slackSignature.js';

const SECRET = 'a-signing-secret';
const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';

const sign = (body, ts, secret = SECRET) =>
  `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

const nowSec = () => Math.floor(Date.now() / 1000);

describe('verifySlackSignature', () => {
  test('accepts a correctly signed, current request', () => {
    const ts = nowSec();
    const res = verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(BODY, ts),
      timestamp: String(ts),
      rawBody: BODY,
    });
    expect(res.ok).toBe(true);
  });

  test('accepts a Buffer body, which is what express hands us', () => {
    const ts = nowSec();
    const res = verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(BODY, ts),
      timestamp: String(ts),
      rawBody: Buffer.from(BODY, 'utf8'),
    });
    expect(res.ok).toBe(true);
  });

  test('rejects a tampered body', () => {
    const ts = nowSec();
    const signature = sign(BODY, ts);
    const res = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp: String(ts),
      rawBody: `${BODY}&extra=1`,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/mismatch/);
  });

  test('rejects a signature made with a different secret', () => {
    const ts = nowSec();
    const res = verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(BODY, ts, 'someone-elses-secret'),
      timestamp: String(ts),
      rawBody: BODY,
    });
    expect(res.ok).toBe(false);
  });

  test('rejects a replay from outside the window', () => {
    // A captured request is valid forever without this.
    const old = nowSec() - (MAX_SKEW_SECONDS + 60);
    const res = verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(BODY, old),
      timestamp: String(old),
      rawBody: BODY,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/replay window/);
  });

  test('rejects a timestamp from the future too', () => {
    const future = nowSec() + (MAX_SKEW_SECONDS + 60);
    const res = verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(BODY, future),
      timestamp: String(future),
      rawBody: BODY,
    });
    expect(res.ok).toBe(false);
  });

  test('a missing raw body is a refusal, never a skip', () => {
    // If a future middleware reorder consumes the body before we see it, this
    // endpoint must break loudly rather than quietly stop authenticating.
    const ts = nowSec();
    for (const rawBody of [undefined, null]) {
      const res = verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(BODY, ts),
        timestamp: String(ts),
        rawBody,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/raw body/);
    }
  });

  test('refuses when no signing secret is configured', () => {
    const ts = nowSec();
    const res = verifySlackSignature({
      signingSecret: '',
      signature: sign(BODY, ts),
      timestamp: String(ts),
      rawBody: BODY,
    });
    expect(res.ok).toBe(false);
  });

  test('refuses missing headers rather than throwing', () => {
    expect(verifySlackSignature({ signingSecret: SECRET, rawBody: BODY }).ok).toBe(false);
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: 'v0=abc', timestamp: 'not-a-number', rawBody: BODY }).ok
    ).toBe(false);
  });

  test('a signature of the wrong length does not throw', () => {
    // timingSafeEqual throws on length mismatch; that must never reach the route.
    const ts = nowSec();
    expect(() =>
      verifySlackSignature({ signingSecret: SECRET, signature: 'v0=short', timestamp: String(ts), rawBody: BODY })
    ).not.toThrow();
  });
});
