/**
 * jwt.js — access-token typ enforcement (critical fix: MFA challenge,
 * bootstrap and RDP gateway tokens, which are all signed with the same
 * JWT_SECRET but WITHOUT typ:'access', must never verify as bearer tokens).
 *
 * Pure unit tests — no DB/Redis required.
 */

import jwt from 'jsonwebtoken';
import config from '../../config/index.js';
import {
  generateAccessToken,
  verifyAccessToken,
  getMfaChallengeKey,
} from '../jwt.js';

describe('generateAccessToken / verifyAccessToken', () => {
  test('a real access token round-trips', () => {
    const token = generateAccessToken({ userId: 'u1', orgId: 'o1', role: 'member', email: 'a@b.com' });
    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe('u1');
    expect(decoded.typ).toBe('access');
  });

  test('generateAccessToken always stamps typ:"access", even if the caller tries to override it', () => {
    const token = generateAccessToken({ userId: 'u1', orgId: 'o1', role: 'member', email: 'a@b.com', typ: 'mfa_challenge' });
    const decoded = verifyAccessToken(token);
    expect(decoded.typ).toBe('access');
  });

  test('rejects a bootstrap-shaped token (same secret, no typ) — the CRITICAL fix', () => {
    const bootstrapToken = jwt.sign({ kind: 'bootstrap', serverId: 's1', orgId: 'o1' }, config.jwt.secret, {
      expiresIn: 30 * 60,
    });
    expect(() => verifyAccessToken(bootstrapToken)).toThrow();
  });

  test('rejects an RDP-gateway-shaped token (same secret, no typ)', () => {
    const gatewayToken = jwt.sign({ purpose: 'rdp-gateway', sessionId: 's1' }, config.jwt.secret, {
      expiresIn: 60,
    });
    expect(() => verifyAccessToken(gatewayToken)).toThrow();
  });

  test('rejects an MFA-challenge-shaped token even if forged with the main JWT secret', () => {
    const forged = jwt.sign({ typ: 'mfa_challenge', userId: 'u1', orgId: 'o1', jti: 'x' }, config.jwt.secret, {
      expiresIn: 300,
    });
    // typ !== 'access' -> rejected regardless of signature validity
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  test('rejects a token signed with a completely different secret', () => {
    const foreign = jwt.sign({ typ: 'access', userId: 'u1', orgId: 'o1' }, 'not-the-real-secret', {
      expiresIn: 60,
    });
    expect(() => verifyAccessToken(foreign)).toThrow();
  });
});

describe('MFA challenge signing key', () => {
  test('is derived (HKDF) from JWT_SECRET and is NOT equal to the raw secret string', () => {
    const key = getMfaChallengeKey();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    expect(key.toString('hex')).not.toBe(Buffer.from(config.jwt.secret).toString('hex'));
  });

  test('a genuine access token cannot be verified using the MFA challenge key', () => {
    const accessToken = generateAccessToken({ userId: 'u1', orgId: 'o1', role: 'member', email: 'a@b.com' });
    expect(() => jwt.verify(accessToken, getMfaChallengeKey())).toThrow();
  });

  test('a token signed with the MFA challenge key cannot be verified as an access token', () => {
    const mfaToken = jwt.sign({ typ: 'mfa_challenge', userId: 'u1' }, getMfaChallengeKey(), { expiresIn: 300 });
    expect(() => verifyAccessToken(mfaToken)).toThrow();
  });
});
