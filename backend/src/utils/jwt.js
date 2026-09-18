import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config/index.js';

// ---------------------------------------------------------------------------
// Access tokens — always carry typ:'access'. verifyAccessToken rejects any
// token missing it, so tokens minted for other purposes (MFA challenge,
// bootstrap, RDP gateway) signed with the same JWT_SECRET can never be used
// as a bearer token against `authenticate`.
// ---------------------------------------------------------------------------

export function generateAccessToken(payload) {
  return jwt.sign({ ...payload, typ: 'access' }, config.jwt.secret, { expiresIn: config.jwt.expiry });
}

export function generateRefreshToken(payload) {
  return jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiry });
}

export function verifyAccessToken(token) {
  const decoded = jwt.verify(token, config.jwt.secret);
  if (!decoded || decoded.typ !== 'access') {
    throw new Error('Token is not a valid access token');
  }
  return decoded;
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// MFA challenge token key — HKDF-derived from JWT_SECRET with a distinct
// "purpose" label, so it is cryptographically independent from the access
// token signing key even though both trace back to the same root secret.
// A forged/leaked mfa_challenge token can never verify as an access token
// (different key, different typ) and vice versa.
// ---------------------------------------------------------------------------

let _mfaChallengeKey = null;

export function getMfaChallengeKey() {
  if (!_mfaChallengeKey) {
    const ikm = Buffer.from(config.jwt.secret, 'utf8');
    const salt = Buffer.alloc(0);
    const info = Buffer.from('shellius:mfa-challenge:v1', 'utf8');
    _mfaChallengeKey = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));
  }
  return _mfaChallengeKey;
}

export default {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  getMfaChallengeKey,
};
