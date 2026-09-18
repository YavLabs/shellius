import crypto from 'crypto';
import config from '../config/index.js';
import logger from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v2';
const DEV_FALLBACK_SEED = 'dev-encryption-key';

let warnedDevFallback = false;

/**
 * Derive a 32-byte AES-256 key from a configured key string.
 *
 * Accepts either a 64-char hex string (interpreted as raw key bytes) or any
 * other string of sufficient length (hashed with SHA-256 to derive 32 bytes).
 */
function deriveKeyBuffer(keyString) {
  if (/^[0-9a-fA-F]{64}$/.test(keyString)) {
    return Buffer.from(keyString, 'hex');
  }
  return crypto.createHash('sha256').update(keyString, 'utf8').digest();
}

/** Non-reversible short identifier for a key, safe to store alongside ciphertext. */
function fingerprint(keyBuffer) {
  return crypto.createHash('sha256').update(keyBuffer).digest('hex').slice(0, 8);
}

function devFallbackKeyBuffer() {
  if (!warnedDevFallback) {
    warnedDevFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[crypto] WARNING: SERVER_ENCRYPTION_KEY is not set. Using an insecure, ' +
        'publicly-known development fallback key. This is only acceptable outside ' +
        'production. Set SERVER_ENCRYPTION_KEY before deploying.'
    );
  }
  return crypto.createHash('sha256').update(DEV_FALLBACK_SEED).digest();
}

/** Current key used for all new encryption. Throws if unavailable in production. */
function getCurrentKeyBuffer() {
  const keyString = config.encryption.key;
  if (!keyString) {
    if (config.nodeEnv === 'production') {
      // config/index.js already throws at startup in this case; this is a
      // defensive second check in case crypto.js is invoked without config
      // having been loaded through the normal startup path.
      throw new Error('SERVER_ENCRYPTION_KEY is not set. Refusing to encrypt/decrypt.');
    }
    return devFallbackKeyBuffer();
  }
  return deriveKeyBuffer(keyString);
}

/** All keys (current + previous) that decryption should be willing to try, by keyId. */
function getKeyRegistry() {
  const registry = new Map();

  const current = getCurrentKeyBuffer();
  registry.set(fingerprint(current), current);

  for (const prevString of config.encryption.previousKeys || []) {
    if (!prevString) continue;
    const buf = deriveKeyBuffer(prevString);
    registry.set(fingerprint(buf), buf);
  }

  return registry;
}

/** Legacy (pre-versioning) candidate keys to brute-force against for old rows. */
function getLegacyCandidateKeys() {
  const candidates = [];
  try {
    candidates.push(getCurrentKeyBuffer());
  } catch {
    /* no current key available (production, misconfigured) — nothing to try */
  }
  for (const prevString of config.encryption.previousKeys || []) {
    if (prevString) candidates.push(deriveKeyBuffer(prevString));
  }
  if (config.nodeEnv !== 'production') {
    candidates.push(crypto.createHash('sha256').update(DEV_FALLBACK_SEED).digest());
  }
  return candidates;
}

function gcmDecrypt(keyBuffer, iv, authTag, encrypted) {
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Encrypt plaintext with the current SERVER_ENCRYPTION_KEY.
 * Always writes the versioned envelope: v2:<keyId>:<base64(iv|tag|ciphertext)>
 */
export function encrypt(plaintext) {
  const keyBuffer = getCurrentKeyBuffer();
  const keyId = fingerprint(keyBuffer);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  return `${ENVELOPE_VERSION}:${keyId}:${blob}`;
}

/**
 * Decrypt ciphertext produced by encrypt(). Transparently supports:
 *  - v2 versioned envelopes (v2:<keyId>:<base64 blob>), matched against the
 *    current key and any SERVER_ENCRYPTION_KEY_PREVIOUS keys by keyId.
 *  - legacy unversioned envelopes (base64(iv|tag|ciphertext)), decrypted by
 *    trying the current key, previous keys, and (outside production) the
 *    dev fallback key.
 */
export function decrypt(ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new Error('decrypt: ciphertext must be a non-empty string');
  }

  if (ciphertext.startsWith(`${ENVELOPE_VERSION}:`)) {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('decrypt: malformed v2 envelope');
    }
    const [, keyId, blobB64] = parts;
    const registry = getKeyRegistry();
    const keyBuffer = registry.get(keyId);
    if (!keyBuffer) {
      throw new Error('decrypt: no matching key for envelope keyId (rotate/reencrypt needed?)');
    }
    const data = Buffer.from(blobB64, 'base64');
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    return gcmDecrypt(keyBuffer, iv, authTag, encrypted);
  }

  // Legacy format: base64(iv(12) | tag(16) | ciphertext), no keyId prefix.
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);

  const candidates = getLegacyCandidateKeys();
  let lastError;
  for (const keyBuffer of candidates) {
    try {
      return gcmDecrypt(keyBuffer, iv, authTag, encrypted);
    } catch (err) {
      lastError = err;
    }
  }
  logger.error('crypto.decrypt: failed to decrypt legacy envelope with all candidate keys');
  throw lastError || new Error('decrypt: unable to decrypt legacy envelope');
}

/** True if a stored value uses the current versioned envelope with the current key. */
export function isCurrentEnvelope(ciphertext) {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(`${ENVELOPE_VERSION}:`)) {
    return false;
  }
  const keyId = ciphertext.split(':')[1];
  try {
    return keyId === fingerprint(getCurrentKeyBuffer());
  } catch {
    return false;
  }
}

export default { encrypt, decrypt, isCurrentEnvelope };
