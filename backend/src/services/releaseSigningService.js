/**
 * releaseSigningService.js — the installation's key for anything Shellius
 * asks a managed host to execute.
 *
 * Why a signature at all, when the host already fetched the script over TLS
 * from a server it was configured to trust? Because those two statements are
 * not the same one. TLS says "these bytes came from whatever is currently
 * answering at that hostname". A signature says "these bytes were produced by
 * THIS installation's key and have not been altered since" — which still
 * holds if a reverse proxy, a caching layer, a corporate TLS-terminating
 * middlebox or a mirror sits in between, all of which are ordinary in the
 * networks this product is deployed into. The host verifies before it
 * executes, and refuses rather than falling back to unverified bytes.
 *
 * RSA rather than Ed25519, for one unglamorous reason: the verifier is
 * `openssl dgst -sha256 -verify` inside a bash script on an arbitrary Linux
 * host, which works back to OpenSSL 1.0.2. Verifying Ed25519 from the openssl
 * CLI needs `pkeyutl -rawin`, which is OpenSSL 3.0+, and a signature scheme
 * the host cannot check is worse than no signature at all — it becomes a
 * check that gets skipped.
 *
 * The private key is encrypted at rest with the same envelope as the SSH CA
 * (utils/crypto.js) and is decrypted in memory only while signing.
 */

import crypto from 'crypto';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';

const SCOPE = 'global';
export const ALGORITHM = 'rsa-4096';
const MODULUS_LENGTH = 4096;

/** SHA-256 over the DER public key — "which key signed this?", short form. */
export function fingerprintOf(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * The installation's signing key, creating it on first use.
 *
 * Generation is racy by nature — two workers booting at once both find no
 * key — so the unique constraint on `scope` is the arbiter: whoever loses the
 * insert re-reads the winner's row rather than overwriting it. A second key
 * silently replacing the first would leave every already-installed host
 * verifying against a public key that no longer signs anything, and the
 * symptom would be a fleet that quietly stops updating.
 */
export async function getOrCreateKey() {
  const existing = await prisma.releaseSigningKey.findUnique({ where: { scope: SCOPE } });
  if (existing) return existing;

  const { publicKey, privateKey } = generate();
  try {
    const row = await prisma.releaseSigningKey.create({
      data: {
        scope: SCOPE,
        algorithm: ALGORITHM,
        publicKeyPem: publicKey,
        privateKeyEncrypted: encrypt(privateKey),
        fingerprint: fingerprintOf(publicKey),
      },
    });
    logger.info('releaseSigning: generated the installation signing key', {
      fingerprint: row.fingerprint,
      algorithm: row.algorithm,
    });
    return row;
  } catch (err) {
    if (err.code === 'P2002') {
      // Lost the race. The winner's key is the one hosts will be given.
      const winner = await prisma.releaseSigningKey.findUnique({ where: { scope: SCOPE } });
      if (winner) return winner;
    }
    throw err;
  }
}

/** The public half, for baking into a host's updater at install time. */
export async function getPublicKey() {
  const key = await getOrCreateKey();
  return { publicKeyPem: key.publicKeyPem, fingerprint: key.fingerprint, algorithm: key.algorithm };
}

/**
 * Sign bytes.
 *
 * PKCS#1 v1.5 over SHA-256, which is exactly what `openssl dgst -sha256
 * -verify` expects — node's default for an RSA key, and deliberately not
 * changed to PSS, because the host-side verifier would then need
 * `-sigopt rsa_padding_mode:pss` and every mismatch would present as a
 * corrupt download rather than a configuration error.
 *
 * @param {Buffer|string} data
 * @returns {Promise<{signature: string, fingerprint: string, algorithm: string}>}
 */
export async function sign(data) {
  const key = await getOrCreateKey();
  const privateKeyPem = decrypt(key.privateKeyEncrypted);
  try {
    const signature = crypto
      .sign('sha256', Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), privateKeyPem)
      .toString('base64');
    return { signature, fingerprint: key.fingerprint, algorithm: key.algorithm };
  } finally {
    // Nothing useful to zero — the PEM is an immutable JS string — but the
    // reference is dropped here rather than being held for the caller's
    // lifetime. Never log it.
  }
}

/**
 * Verify, using the same rules the host does.
 *
 * Exists so a test can prove the two agree, and so an operator-facing "check
 * this bundle" can exist without shelling out to openssl.
 */
export async function verify(data, signatureB64, publicKeyPem = null) {
  const pem = publicKeyPem || (await getOrCreateKey()).publicKeyPem;
  try {
    return crypto.verify(
      'sha256',
      Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'),
      pem,
      Buffer.from(signatureB64, 'base64')
    );
  } catch {
    // A malformed signature is a failed verification, not an exception —
    // the host treats it the same way.
    return false;
  }
}

/** SHA-256 of the payload, as the updater's cheap pre-check. */
export function digestOf(data) {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
    .digest('hex');
}

export default { ALGORITHM, fingerprintOf, getOrCreateKey, getPublicKey, sign, verify, digestOf };
