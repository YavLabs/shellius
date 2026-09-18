/**
 * sshKeys.js
 *
 * Keystore key-material helpers: generate new SSH key pairs, import/validate
 * existing private keys, and compute fingerprints.
 *
 * Security:
 *   - Generation always happens in a mkdtemp'd directory (mode 0700), and the
 *     directory is always removed (finally) — key material never lingers on
 *     disk after the caller has read it into memory.
 *   - Import/parsing never shells out or writes the private key to disk —
 *     it is parsed in-process via `sshpk`, which never prompts and fails
 *     closed on a wrong/missing passphrase.
 *   - Callers are responsible for encrypting the returned private key before
 *     persisting it (utils/crypto.js) and for never logging key material.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sshpk from 'sshpk';

import ApiError from './ApiError.js';

const execFileAsync = promisify(execFile);

export const KEY_TYPES = ['ed25519', 'rsa', 'ecdsa'];
export const RSA_BITS = [2048, 3072, 4096];
export const ECDSA_BITS = [256, 384, 521];

// A single-line OpenSSH public key: <type> <base64> [comment]
const OPENSSH_PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\s+[A-Za-z0-9+/]+=*(\s+.*)?$/;

/**
 * Validate that a string is a well-formed single-line OpenSSH public key.
 * Used before ever passing a "public key" into a shell command / file.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidOpenSshPublicKey(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.includes('\n')) return false; // must be single-line
  return OPENSSH_PUBLIC_KEY_RE.test(trimmed);
}

/**
 * Parse the fingerprint line from `ssh-keygen -lf <pubkey>` output.
 * Example: "256 SHA256:abc123... comment (ED25519)"
 */
function parseFingerprintLine(output) {
  const line = output.trim().split('\n')[0];
  const parts = line.split(' ');
  return parts[1] || line;
}

/**
 * Compute the SHA256 fingerprint of an OpenSSH public key string.
 * @param {string} publicKey
 * @returns {string} "SHA256:..."
 */
export function fingerprintPublicKey(publicKey) {
  if (!isValidOpenSshPublicKey(publicKey)) {
    throw new ApiError(400, 'Not a valid OpenSSH public key');
  }
  try {
    const key = sshpk.parseKey(publicKey.trim(), 'ssh');
    return key.fingerprint('sha256').toString();
  } catch (err) {
    throw new ApiError(400, `Failed to parse public key: ${err.message}`);
  }
}

/**
 * Generate a new SSH key pair with `ssh-keygen` in a private temp directory.
 *
 * @param {object} params
 * @param {'ed25519'|'rsa'|'ecdsa'} [params.keyType='ed25519']
 * @param {number} [params.bits]        - rsa: 2048|3072|4096, ecdsa: 256|384|521
 * @param {string} [params.comment='']
 * @param {string} [params.passphrase='']
 * @returns {Promise<{ keyType, bits, publicKey, privateKey, fingerprint, comment }>}
 */
export async function generateKeyPair({
  keyType = 'ed25519',
  bits,
  comment = '',
  passphrase = '',
} = {}) {
  if (!KEY_TYPES.includes(keyType)) {
    throw new ApiError(400, `keyType must be one of: ${KEY_TYPES.join(', ')}`);
  }

  let effectiveBits;
  if (keyType === 'rsa') {
    effectiveBits = bits && RSA_BITS.includes(bits) ? bits : 3072;
  } else if (keyType === 'ecdsa') {
    effectiveBits = bits && ECDSA_BITS.includes(bits) ? bits : 256;
  } else {
    effectiveBits = null; // ed25519 has a fixed size
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-keygen-'));
  await fs.chmod(tmpDir, 0o700);
  const keyPath = path.join(tmpDir, 'key');

  try {
    const args = ['-t', keyType, '-N', passphrase || '', '-C', comment || '', '-f', keyPath, '-q'];
    if (effectiveBits) args.push('-b', String(effectiveBits));

    await execFileAsync('ssh-keygen', args);

    const [privateKeyRaw, publicKeyRaw] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(`${keyPath}.pub`, 'utf8'),
    ]);

    const { stdout: fpOut } = await execFileAsync('ssh-keygen', ['-lf', `${keyPath}.pub`]);
    const fingerprint = parseFingerprintLine(fpOut);

    // Determine actual bit size from the fingerprint line's leading number
    // (authoritative — ssh-keygen may pick a slightly different default).
    const sizeMatch = fpOut.trim().match(/^(\d+)\s/);
    const actualBits = sizeMatch ? parseInt(sizeMatch[1], 10) : effectiveBits;

    return {
      keyType,
      bits: keyType === 'ed25519' ? null : actualBits,
      publicKey: publicKeyRaw.trim(),
      privateKey: privateKeyRaw, // keep trailing newline — OpenSSH format requires it
      fingerprint,
      comment: comment || '',
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ApiError(500, 'ssh-keygen is not available on the server');
    }
    throw new ApiError(400, `Key generation failed: ${err.message}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Parse/import an existing OpenSSH/PEM private key. Validates the key parses
 * (and, if encrypted, that the supplied passphrase decrypts it), and derives
 * the OpenSSH public key, fingerprint, type, and bit size. Never touches disk.
 *
 * @param {object} params
 * @param {string} params.privateKey
 * @param {string} [params.passphrase]
 * @returns {Promise<{ keyType, bits, publicKey, fingerprint, comment }>}
 */
export async function importPrivateKey({ privateKey, passphrase }) {
  if (!privateKey || typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new ApiError(400, 'privateKey is required');
  }

  let key;
  try {
    key = sshpk.parsePrivateKey(privateKey, 'auto', passphrase ? { passphrase } : undefined);
  } catch (err) {
    if (err instanceof sshpk.KeyEncryptedError) {
      throw new ApiError(400, 'This private key is passphrase-protected; supply the passphrase to import it.', {
        code: 'KEY_PASSPHRASE_REQUIRED',
      });
    }
    if (/incorrect passphrase/i.test(err.message || '')) {
      throw new ApiError(400, 'Incorrect passphrase for this private key.', { code: 'KEY_BAD_PASSPHRASE' });
    }
    throw new ApiError(400, `Could not parse private key: ${err.message}`);
  }

  let publicKey;
  let fingerprint;
  try {
    const pub = key.toPublic();
    publicKey = pub.toString('ssh').trim();
    fingerprint = pub.fingerprint('sha256').toString();
  } catch (err) {
    throw new ApiError(400, `Failed to derive public key: ${err.message}`);
  }

  // sshpk key.type: 'ed25519' | 'rsa' | 'ecdsa' | 'dsa' | ...
  const keyType = key.type === 'ecdsa' ? 'ecdsa' : key.type;
  if (!KEY_TYPES.includes(keyType)) {
    throw new ApiError(400, `Unsupported key type: ${key.type}`);
  }

  // Comment, if any, is the trailing token on the public-key line.
  const parts = publicKey.split(/\s+/);
  const comment = parts.length > 2 ? parts.slice(2).join(' ') : '';

  return {
    keyType,
    bits: keyType === 'ed25519' ? null : key.size,
    publicKey,
    fingerprint,
    comment,
  };
}

export default {
  KEY_TYPES,
  RSA_BITS,
  ECDSA_BITS,
  isValidOpenSshPublicKey,
  fingerprintPublicKey,
  generateKeyPair,
  importPrivateKey,
};
