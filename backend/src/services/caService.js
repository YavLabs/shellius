import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import prisma from '../config/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import logger from '../utils/logger.js';
import ApiError from '../utils/ApiError.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write a file with mode 0600 (owner read/write only).
 */
async function writeSecret(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o600 });
}

/**
 * Derive a random BigInt serial from crypto.randomBytes so we control it for
 * DB uniqueness and can pass it to ssh-keygen via -z.
 * Returns a positive BigInt that fits in a signed 64-bit integer (Postgres bigint).
 */
function randomSerial() {
  // 7 bytes => 56 bits, well within signed int64 max (63 bits)
  const buf = crypto.randomBytes(7);
  return BigInt(`0x${buf.toString('hex')}`) + 1n; // ensure > 0
}

/**
 * Parse the fingerprint line from `ssh-keygen -lf <pubkey>` output.
 * Example line: "256 SHA256:abc123... shellius-ca-xxx (ED25519)"
 * Returns the full fingerprint field (e.g. "SHA256:abc123...").
 */
function parseFingerprintLine(output) {
  const line = output.trim().split('\n')[0];
  const parts = line.split(' ');
  // parts[1] is the SHA256:... fingerprint
  return parts[1] || line;
}

/**
 * Run ssh-keygen to compute the fingerprint of a public key file.
 */
async function computeFingerprint(pubKeyPath) {
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', pubKeyPath]);
  return parseFingerprintLine(stdout);
}

// ---------------------------------------------------------------------------
// Audit helper — writes an AuditLog row directly from service layer.
// Route-level audit middleware covers HTTP mutations; these cover non-HTTP paths
// (e.g. rotation triggered by a job) and supplement route audit.
// ---------------------------------------------------------------------------
async function writeAudit(orgId, action, resourceId, metadata = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: null, // system-initiated; callers may override if they have actorId
        action,
        resourceType: 'CaKeyPair',
        resourceId: resourceId ?? null,
        metadata,
      },
    });
  } catch (err) {
    logger.error('caService: audit log write failed', { action, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new Ed25519 CA key pair, encrypt the private key, and persist to DB.
 *
 * @param {string} orgId
 * @param {string} name  - Human-readable label for this CA key pair
 * @returns {Promise<import('@prisma/client').CaKeyPair>}
 */
export async function generateCaKeyPair(orgId, name) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!name) throw new ApiError(400, 'name is required');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-ca-'));
  const caKeyPath = path.join(tmpDir, 'ca_key');

  try {
    // Generate Ed25519 key pair (no passphrase — we do our own encryption)
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519',
      '-N', '',
      '-C', `shellius-ca-${orgId}`,
      '-f', caKeyPath,
    ]);

    const [privateKeyRaw, publicKey] = await Promise.all([
      fs.readFile(caKeyPath, 'utf8'),
      fs.readFile(`${caKeyPath}.pub`, 'utf8'),
    ]);

    const fingerprint = await computeFingerprint(`${caKeyPath}.pub`);

    // Encrypt private key — encrypt() returns base64 blob with iv+tag prepended
    const encryptedBlob = encrypt(privateKeyRaw.trim());

    // We need to store iv and tag separately to match the schema columns.
    // The existing encrypt() packs: iv(12) + tag(16) + ciphertext → base64.
    // Decode to pull out the parts.
    const blobBuf = Buffer.from(encryptedBlob, 'base64');
    const iv = blobBuf.subarray(0, 12).toString('hex');
    const tag = blobBuf.subarray(12, 28).toString('hex');
    // Store the full blob in encryptedPrivateKey so decrypt() can reconstruct it
    const encryptedPrivateKey = encryptedBlob;

    // Deactivate any currently active keys for this org first
    await prisma.caKeyPair.updateMany({
      where: { orgId, isActive: true },
      data: { isActive: false },
    });

    const record = await prisma.caKeyPair.create({
      data: {
        orgId,
        name,
        algorithm: 'Ed25519',
        publicKey: publicKey.trim(),
        encryptedPrivateKey,
        encryptionIv: iv,
        encryptionTag: tag,
        fingerprint,
        isActive: true,
      },
    });

    logger.info('caService: CA key pair generated', {
      orgId,
      caKeyPairId: record.id,
      fingerprint,
    });

    await writeAudit(orgId, 'ca.key_pair.generated', record.id, { fingerprint, name });

    return record;
  } finally {
    // Always remove temp files — force:true silently ignores missing files
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Sign a user or host public key with the org's active CA key.
 *
 * @param {object} params
 * @param {string}   params.orgId
 * @param {string}   params.publicKey        - PEM/OpenSSH public key to sign
 * @param {string[]} params.principals       - Allowed principals (usernames / hostnames)
 * @param {number}   params.validitySeconds  - Certificate TTL in seconds
 * @param {'USER'|'HOST'} [params.certType='USER']
 * @param {string}   params.keyId            - Free-form identifier embedded in cert
 * @param {object}   [params.extensions={}]  - ssh-keygen extension flags
 * @param {object}   [params.criticalOptions={}] - ssh-keygen critical option flags
 * @returns {Promise<{ signedCert: string, serial: BigInt, caKeyPairId: string }>}
 */
export async function signCertificate({
  orgId,
  publicKey,
  principals,
  validitySeconds,
  certType = 'USER',
  keyId,
  extensions = {},
  criticalOptions = {},
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!publicKey) throw new ApiError(400, 'publicKey is required');
  if (!Array.isArray(principals) || principals.length === 0) {
    throw new ApiError(400, 'principals must be a non-empty array');
  }
  if (!validitySeconds || validitySeconds <= 0) {
    throw new ApiError(400, 'validitySeconds must be a positive number');
  }
  if (!keyId) throw new ApiError(400, 'keyId is required');

  const caKeyPair = await prisma.caKeyPair.findFirst({
    where: { orgId, isActive: true },
  });
  if (!caKeyPair) {
    throw new ApiError(404, 'No active CA key pair found for organization');
  }

  const serial = randomSerial();

  // Decrypt private key into a Buffer — NEVER write unencrypted key to disk
  let caPrivBuffer;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-sign-'));

  try {
    const decryptedPrivKey = decrypt(caKeyPair.encryptedPrivateKey);
    caPrivBuffer = Buffer.from(decryptedPrivKey, 'utf8');

    const caPrivPath = path.join(tmpDir, 'ca_key');
    const userPubPath = path.join(tmpDir, 'user_key.pub');

    // ssh-keygen requires the OpenSSH private key file to end with a newline.
    // The generator helper trims input before encryption, so re-append it.
    const caPrivText = caPrivBuffer.toString('utf8');
    await writeSecret(caPrivPath, caPrivText.endsWith('\n') ? caPrivText : caPrivText + '\n');
    await fs.writeFile(userPubPath, publicKey.trim() + '\n', { mode: 0o644 });

    // Build ssh-keygen args
    const args = [
      '-s', caPrivPath,
      '-I', keyId,
      '-n', principals.join(','),
      '-V', `+${validitySeconds}s`,
      '-z', serial.toString(),
    ];

    if (certType === 'HOST') {
      args.push('-h');
    }

    // Extension flags (e.g. { 'permit-pty': '', 'permit-user-rc': '' })
    for (const [extName, extVal] of Object.entries(extensions)) {
      if (extVal === '' || extVal === true) {
        args.push('-O', `extension=${extName}`);
      } else {
        args.push('-O', `extension=${extName}=${extVal}`);
      }
    }

    // Critical option flags (e.g. { 'source-address': '10.0.0.0/8' })
    for (const [optName, optVal] of Object.entries(criticalOptions)) {
      args.push('-O', `critical:${optName}=${optVal}`);
    }

    args.push(userPubPath);

    await execFileAsync('ssh-keygen', args);

    const certPath = path.join(tmpDir, 'user_key-cert.pub');
    const signedCert = await fs.readFile(certPath, 'utf8');

    logger.info('caService: certificate signed', {
      orgId,
      caKeyPairId: caKeyPair.id,
      serial: serial.toString(),
      keyId,
      principals,
      certType,
      validitySeconds,
    });

    return {
      signedCert: signedCert.trim(),
      serial,
      caKeyPairId: caKeyPair.id,
    };
  } finally {
    // Zero out the in-memory private key buffer
    if (caPrivBuffer) {
      caPrivBuffer.fill(0);
    }
    // Always clean up temp dir
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Mark a certificate as revoked.
 *
 * @param {string} certId      - Certificate DB id
 * @param {string} revokedById - User id performing the revocation
 * @returns {Promise<import('@prisma/client').Certificate>}
 */
export async function revokeCertificate(certId, revokedById) {
  if (!certId) throw new ApiError(400, 'certId is required');

  const cert = await prisma.certificate.findUnique({ where: { id: certId } });
  if (!cert) throw new ApiError(404, 'Certificate not found');
  if (cert.status === 'REVOKED') throw new ApiError(409, 'Certificate is already revoked');

  const updated = await prisma.certificate.update({
    where: { id: certId },
    data: {
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedById: revokedById ?? null,
    },
  });

  logger.info('caService: certificate revoked', {
    orgId: cert.orgId,
    certId,
    serial: cert.serial?.toString(),
    revokedById,
  });

  await writeAudit(cert.orgId, 'certificate.revoked', certId, {
    serial: cert.serial?.toString(),
    revokedById,
  });

  return updated;
}

/**
 * Rotate the CA key pair for an org.
 * Atomically (in a transaction): deactivates the current active key and
 * creates a new key pair.
 *
 * NOTE: generateCaKeyPair() uses fs I/O and execFile which cannot run inside
 * a Prisma interactive transaction. Instead we:
 *   1. Generate new key material outside the transaction
 *   2. Run the DB swap in a transaction
 *   3. Clean up if the transaction fails
 *
 * @param {string} orgId
 * @param {string} name  - Name for the new CA key pair
 * @returns {Promise<{ newKeyPair: object, oldKeyPairId: string|null }>}
 */
export async function rotateCaKeyPair(orgId, name) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!name) throw new ApiError(400, 'name is required');

  // Find the currently active key pair
  const current = await prisma.caKeyPair.findFirst({
    where: { orgId, isActive: true },
  });

  // Generate new key material in a temp dir
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-rotate-'));
  const caKeyPath = path.join(tmpDir, 'ca_key');

  let privateKeyRaw, publicKey, fingerprint, encryptedBlob, iv, tag;

  try {
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519',
      '-N', '',
      '-C', `shellius-ca-${orgId}`,
      '-f', caKeyPath,
    ]);

    [privateKeyRaw, publicKey] = await Promise.all([
      fs.readFile(caKeyPath, 'utf8'),
      fs.readFile(`${caKeyPath}.pub`, 'utf8'),
    ]);

    fingerprint = await computeFingerprint(`${caKeyPath}.pub`);
    encryptedBlob = encrypt(privateKeyRaw.trim());

    const blobBuf = Buffer.from(encryptedBlob, 'base64');
    iv = blobBuf.subarray(0, 12).toString('hex');
    tag = blobBuf.subarray(12, 28).toString('hex');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // Atomically swap in the DB
  const now = new Date();
  const newKeyPair = await prisma.$transaction(async (tx) => {
    if (current) {
      await tx.caKeyPair.update({
        where: { id: current.id },
        data: { isActive: false, rotatedAt: now },
      });
    }

    return tx.caKeyPair.create({
      data: {
        orgId,
        name,
        algorithm: 'Ed25519',
        publicKey: publicKey.trim(),
        encryptedPrivateKey: encryptedBlob,
        encryptionIv: iv,
        encryptionTag: tag,
        fingerprint,
        isActive: true,
      },
    });
  });

  logger.info('caService: CA key pair rotated', {
    orgId,
    oldKeyPairId: current?.id ?? null,
    newKeyPairId: newKeyPair.id,
    fingerprint,
  });

  await writeAudit(orgId, 'ca.key_pair.rotated', newKeyPair.id, {
    oldKeyPairId: current?.id ?? null,
    fingerprint,
    name,
  });

  return { newKeyPair, oldKeyPairId: current?.id ?? null };
}

/**
 * Return the active CA public key for an org.
 *
 * @param {string} orgId
 * @returns {Promise<string>}
 */
export async function getPublicKey(orgId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const caKeyPair = await prisma.caKeyPair.findFirst({
    where: { orgId, isActive: true },
    select: { publicKey: true },
  });

  if (!caKeyPair) {
    throw new ApiError(404, 'No active CA key pair found for organization');
  }

  return caKeyPair.publicKey;
}

/**
 * Return the active CA key fingerprint for an org.
 *
 * @param {string} orgId
 * @returns {Promise<string>}
 */
export async function getFingerprint(orgId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const caKeyPair = await prisma.caKeyPair.findFirst({
    where: { orgId, isActive: true },
    select: { fingerprint: true },
  });

  if (!caKeyPair) {
    throw new ApiError(404, 'No active CA key pair found for organization');
  }

  return caKeyPair.fingerprint;
}

export default {
  generateCaKeyPair,
  signCertificate,
  revokeCertificate,
  rotateCaKeyPair,
  getPublicKey,
  getFingerprint,
};
