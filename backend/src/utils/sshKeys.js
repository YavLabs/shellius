/**
 * sshKeys.js
 *
 * Keystore key-material helpers: generate new SSH key pairs, import/validate
 * existing private keys (auto-detecting format from content), compute
 * fingerprints, and parse OpenSSH user certificates.
 *
 * Supported private key inputs (see docs/keystore-and-quick-connect.md,
 * "Key import"):
 *   - OpenSSH (`BEGIN OPENSSH PRIVATE KEY`), incl. bcrypt-encrypted
 *   - PEM PKCS#1 RSA (`BEGIN RSA PRIVATE KEY`), incl. legacy
 *     `Proc-Type: 4,ENCRYPTED` / `DEK-Info` encryption
 *   - SEC1 EC (`BEGIN EC PRIVATE KEY`)
 *   - PKCS#8, plain and `ENCRYPTED PRIVATE KEY`
 *   - PuTTY `.ppk` v2 (plain + aes256-cbc) and v3 (plain + Argon2-derived
 *     aes256-cbc, MAC-verified)
 * DSA is rejected (KEY_UNSUPPORTED_TYPE). Anything else is
 * KEY_UNSUPPORTED_FORMAT.
 *
 * Security:
 *   - Generation always happens in a mkdtemp'd directory (mode 0700), and the
 *     directory is always removed (finally) — key material never lingers on
 *     disk after the caller has read it into memory.
 *   - Import/parsing never shells out or writes the private key to disk — it
 *     is parsed in-process (sshpk for OpenSSH/PEM/PKCS8, a purpose-built
 *     reader here for PuTTY .ppk), and fails closed on a wrong/missing
 *     passphrase.
 *   - A passphrase-protected input is re-encrypted with the SAME passphrase
 *     when normalised to OpenSSH format (it stays protected at rest, on top
 *     of the AES-256-GCM envelope applied by the caller).
 *   - Callers are responsible for encrypting the returned private key before
 *     persisting it (utils/crypto.js) and for never logging key material.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sshpk from 'sshpk';
import { argon2d, argon2i, argon2id } from 'hash-wasm';

// sshpk doesn't publicly export its internal wire-format helpers, but it
// ships them as plain CommonJS modules we can reach directly — used here to
// build a PrivateKey from parts we parse out of a PuTTY .ppk file ourselves
// (sshpk's own PuTTY reader supports v2 only, doesn't verify the MAC, and
// rejects encrypted v3 outright).
import rfc4253 from 'sshpk/lib/formats/rfc4253.js';
import SSHBuffer from 'sshpk/lib/ssh-buffer.js';

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
      format: 'openssh',
      encrypted: !!passphrase,
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

// ---------------------------------------------------------------------------
// Key import — format detection, pasted-key recovery, PuTTY .ppk v2/v3
// ---------------------------------------------------------------------------

/**
 * Best-effort recovery of a private key that was pasted/copied in a way that
 * lost its internal line breaks (common when copying out of a UI textbox or
 * a spreadsheet cell): if the text has a matching PEM/OpenSSH BEGIN/END pair
 * but almost no internal newlines, re-wrap the base64 body at 64 columns.
 * Leaves anything that already looks well-formed untouched.
 * @param {string} raw
 * @returns {string}
 */
function recoverKeyText(raw) {
  let text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  const begin = text.match(/-----BEGIN ([A-Z0-9 ]+?)-----/);
  const end = text.match(/-----END ([A-Z0-9 ]+?)-----/);
  if (!begin || !end) return text; // not PEM-ish (e.g. PPK, or unsupported) — leave alone

  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length > 3) {
    // Already looks like a normal multi-line PEM file.
    return text;
  }

  const type = begin[1];
  const startIdx = text.indexOf(begin[0]) + begin[0].length;
  const endIdx = text.indexOf(end[0]);
  if (endIdx <= startIdx) return text;

  let body = text.slice(startIdx, endIdx);

  // Legacy PKCS#1/SEC1 encrypted keys carry two extra header lines
  // (Proc-Type / DEK-Info) before the base64 body; pull them out if present
  // even when everything got joined onto one line.
  const headerLines = [];
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = body.match(/^\s*(Proc-Type:\s*4,ENCRYPTED|DEK-Info:\s*[A-Za-z0-9-]+,[0-9A-Fa-f]+)\s*/))) {
    headerLines.push(m[1].trim());
    body = body.slice(m[0].length);
  }

  const b64 = body.replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    return text; // doesn't look safely recoverable — let the real parser fail with a clear error
  }

  const wrapped = b64.match(/.{1,64}/g) || [b64];
  const out = [`-----BEGIN ${type}-----`, ...headerLines];
  if (headerLines.length) out.push('');
  out.push(...wrapped, `-----END ${type}-----`, '');
  return out.join('\n');
}

/**
 * Peek at an (unencrypted-to-read, though possibly key-encrypted) OpenSSH
 * private key blob to see which cipher its KDF section names, without
 * needing the passphrase. Returns `true`/`false`, or `null` if it couldn't
 * be determined (malformed — the real parser will report a clean error).
 */
function opensshCipherIsNone(pemText) {
  try {
    const b64 = pemText
      .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/, '')
      .replace(/-----END OPENSSH PRIVATE KEY-----/, '')
      .replace(/\s+/g, '');
    const buf = Buffer.from(b64, 'base64');
    const MAGIC = 'openssh-key-v1\0';
    if (buf.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) return null;
    let offset = MAGIC.length;
    const len = buf.readUInt32BE(offset);
    offset += 4;
    const cipher = buf.subarray(offset, offset + len).toString('utf8');
    return cipher === 'none';
  } catch {
    return null;
  }
}

/**
 * Detect a private key's format from its content. Does not validate the key
 * material itself — just enough to route to the right parser and to report
 * `format`/`encrypted` for the inspect endpoint.
 * @param {string} text
 * @returns {{ format: string|null, encrypted: boolean }}
 */
export function detectFormat(text) {
  const trimmed = String(text).trim();

  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(trimmed)) {
    return { format: 'openssh', encrypted: opensshCipherIsNone(trimmed) === false };
  }
  if (/-----BEGIN (RSA|DSA) PRIVATE KEY-----/.test(trimmed)) {
    return { format: 'pkcs1', encrypted: /Proc-Type:\s*4\s*,\s*ENCRYPTED/i.test(trimmed) };
  }
  if (/-----BEGIN EC PRIVATE KEY-----/.test(trimmed)) {
    return { format: 'sec1', encrypted: /Proc-Type:\s*4\s*,\s*ENCRYPTED/i.test(trimmed) };
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(trimmed)) {
    return { format: 'pkcs8', encrypted: true };
  }
  if (/-----BEGIN PRIVATE KEY-----/.test(trimmed)) {
    return { format: 'pkcs8', encrypted: false };
  }

  const ppkMatch = trimmed.match(/^putty-user-key-file-(\d+)\s*:/im);
  if (ppkMatch) {
    const version = ppkMatch[1];
    const encMatch = trimmed.match(/^Encryption:\s*(\S+)/im);
    const encrypted = !!encMatch && encMatch[1].toLowerCase() !== 'none';
    return { format: version === '3' ? 'ppk3' : version === '2' ? 'ppk2' : null, encrypted };
  }

  return { format: null, encrypted: false };
}

/** SSH wire "string": 4-byte big-endian length prefix + raw bytes. */
function sshWireString(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Parse a PuTTY `.ppk` file (format version 2 or 3), decrypting it (aes256-cbc)
 * and verifying its `Private-MAC` if it's encrypted. Implements the format
 * from PuTTY's Appendix C documentation directly (sshpk's built-in PuTTY
 * reader supports only v2, doesn't verify the MAC, and refuses encrypted v3).
 *
 * v2 key derivation: cipher key = SHA1(0x00000000 || passphrase) ||
 *   SHA1(0x00000001 || passphrase) truncated to 32 bytes, IV = 16 zero bytes,
 *   MAC key = SHA1("putty-private-key-file-mac-key" || passphrase).
 * v3 key derivation: Argon2(id/i/d per `Key-Derivation`) over the passphrase
 *   with the file's salt/memory/passes/parallelism, producing 80 bytes:
 *   [0:32) = AES-256 key, [32:48) = IV, [48:80) = HMAC-SHA-256 MAC key.
 * Both versions MAC over: string(algo) || string(encryption) ||
 *   string(comment) || string(public-blob) || string(private-plaintext),
 *   HMAC-SHA-1 for v2 / HMAC-SHA-256 for v3.
 *
 * @param {string} text
 * @param {string} [passphrase]
 * @returns {Promise<{ key: sshpk.PrivateKey, encrypted: boolean, formatVersion: 2|3 }>}
 */
async function readPuttyKey(text, passphrase) {
  const norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = norm.split('\n');
  let li = 0;

  const readHeader = (expected) => {
    while (li < lines.length && lines[li].trim() === '') li++;
    if (li >= lines.length) {
      throw new ApiError(400, `Malformed PuTTY key file (expected "${expected}")`, {
        code: 'KEY_UNSUPPORTED_FORMAT',
      });
    }
    const line = lines[li++];
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new ApiError(400, `Malformed PuTTY key file (expected "${expected}")`, {
        code: 'KEY_UNSUPPORTED_FORMAT',
      });
    }
    return { key: line.slice(0, idx).trim(), val: line.slice(idx + 1).trim() };
  };

  const first = readHeader('PuTTY-User-Key-File');
  const versionMatch = first.key.match(/^PuTTY-User-Key-File-(\d+)$/i);
  if (!versionMatch) {
    throw new ApiError(400, 'Not a PuTTY private key file', { code: 'KEY_UNSUPPORTED_FORMAT' });
  }
  const version = parseInt(versionMatch[1], 10);
  if (version !== 2 && version !== 3) {
    throw new ApiError(400, `Unsupported PuTTY key file version ${version}`, {
      code: 'KEY_UNSUPPORTED_FORMAT',
    });
  }
  const algo = first.val;

  const encryption = readHeader('Encryption').val;
  const comment = readHeader('Comment').val;

  const nPub = parseInt(readHeader('Public-Lines').val, 10);
  if (!Number.isFinite(nPub) || nPub < 0) {
    throw new ApiError(400, 'Malformed PuTTY key file (Public-Lines)', { code: 'KEY_UNSUPPORTED_FORMAT' });
  }
  const publicBlob = Buffer.from(lines.slice(li, li + nPub).join(''), 'base64');
  li += nPub;

  if (algo === 'ssh-dss') {
    throw new ApiError(400, 'DSA keys are not supported (deprecated)', { code: 'KEY_UNSUPPORTED_TYPE' });
  }

  let kdf = null;
  if (version === 3 && encryption !== 'none') {
    kdf = { type: readHeader('Key-Derivation').val.toLowerCase() };
    kdf.memory = parseInt(readHeader('Argon2-Memory').val, 10);
    kdf.passes = parseInt(readHeader('Argon2-Passes').val, 10);
    kdf.parallelism = parseInt(readHeader('Argon2-Parallelism').val, 10);
    kdf.salt = Buffer.from(readHeader('Argon2-Salt').val, 'hex');
  }

  const nPriv = parseInt(readHeader('Private-Lines').val, 10);
  if (!Number.isFinite(nPriv) || nPriv < 0) {
    throw new ApiError(400, 'Malformed PuTTY key file (Private-Lines)', { code: 'KEY_UNSUPPORTED_FORMAT' });
  }
  let privateBlob = Buffer.from(lines.slice(li, li + nPriv).join(''), 'base64');
  li += nPriv;

  let macValue = null;
  while (li < lines.length && lines[li].trim() === '') li++;
  if (li < lines.length && lines[li].includes(':')) {
    macValue = readHeader('Private-MAC').val;
  }

  const encrypted = encryption !== 'none';

  if (encrypted) {
    if (encryption !== 'aes256-cbc') {
      throw new ApiError(400, `Unsupported PuTTY encryption "${encryption}"`, {
        code: 'KEY_UNSUPPORTED_FORMAT',
      });
    }
    if (!passphrase) {
      throw new ApiError(
        400,
        'This private key is passphrase-protected; supply the passphrase to import it.',
        { code: 'KEY_PASSPHRASE_REQUIRED' }
      );
    }

    let cipherKey;
    let iv;
    let macKey;

    if (version === 2) {
      const h0 = crypto
        .createHash('sha1')
        .update(Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(passphrase, 'utf8')]))
        .digest();
      const h1 = crypto
        .createHash('sha1')
        .update(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(passphrase, 'utf8')]))
        .digest();
      cipherKey = Buffer.concat([h0, h1]).subarray(0, 32);
      iv = Buffer.alloc(16, 0);
      macKey = crypto
        .createHash('sha1')
        .update(Buffer.concat([Buffer.from('putty-private-key-file-mac-key', 'utf8'), Buffer.from(passphrase, 'utf8')]))
        .digest();
    } else {
      const argon2fn = { argon2id, argon2i, argon2d }[kdf.type];
      if (!argon2fn) {
        throw new ApiError(400, `Unsupported PuTTY Key-Derivation "${kdf.type}"`, {
          code: 'KEY_UNSUPPORTED_FORMAT',
        });
      }
      const out = await argon2fn({
        password: Buffer.from(passphrase, 'utf8'),
        salt: kdf.salt,
        parallelism: kdf.parallelism,
        iterations: kdf.passes,
        memorySize: kdf.memory,
        hashLength: 80,
        outputType: 'binary',
      });
      const outBuf = Buffer.from(out);
      cipherKey = outBuf.subarray(0, 32);
      iv = outBuf.subarray(32, 48);
      macKey = outBuf.subarray(48, 80);
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
      decipher.setAutoPadding(false);
      privateBlob = Buffer.concat([decipher.update(privateBlob), decipher.final()]);
    } catch (err) {
      throw new ApiError(400, `Failed to decrypt PuTTY key: ${err.message}`, {
        code: 'KEY_PASSPHRASE_INVALID',
      });
    }

    // The MAC covers the full decrypted private-blob buffer exactly as
    // stored on disk — including its trailing CBC pad bytes (PuTTY does not
    // record an unpadded length anywhere) — so it must be computed BEFORE
    // parsing the individual fields out of it.
    if (macValue) {
      const macData = Buffer.concat([
        sshWireString(algo),
        sshWireString(encryption),
        sshWireString(comment),
        sshWireString(publicBlob),
        sshWireString(privateBlob),
      ]);
      const macAlgo = version === 2 ? 'sha1' : 'sha256';
      const computed = crypto.createHmac(macAlgo, macKey).update(macData).digest('hex');
      if (!timingSafeEqualHex(computed, macValue)) {
        throw new ApiError(400, 'Incorrect passphrase for this private key.', {
          code: 'KEY_PASSPHRASE_INVALID',
        });
      }
    }

    const pub = rfc4253.read(publicBlob);
    const sshbuf = new SSHBuffer({ buffer: privateBlob });
    const privateParts = readPuttyPrivateParts(algo, sshbuf);
    const key = new sshpk.PrivateKey({ type: pub.type, parts: pub.parts.concat(privateParts) });
    key.comment = comment;
    return { key, encrypted: true, formatVersion: version };
  }

  // Unencrypted — no MAC verification needed (nothing secret to get wrong).
  const pub = rfc4253.read(publicBlob);
  const sshbuf = new SSHBuffer({ buffer: privateBlob });
  const privateParts = readPuttyPrivateParts(algo, sshbuf);
  const key = new sshpk.PrivateKey({ type: pub.type, parts: pub.parts.concat(privateParts) });
  key.comment = comment;
  return { key, encrypted: false, formatVersion: version };
}

function readPuttyPrivateParts(algo, sshbuf) {
  if (algo === 'ssh-rsa') {
    return [
      { name: 'd', data: sshbuf.readBuffer() },
      { name: 'p', data: sshbuf.readBuffer() },
      { name: 'q', data: sshbuf.readBuffer() },
      { name: 'iqmp', data: sshbuf.readBuffer() },
    ];
  }
  if (/^ecdsa-sha2-nistp/.test(algo)) {
    return [{ name: 'd', data: sshbuf.readBuffer() }];
  }
  if (algo === 'ssh-ed25519') {
    return [{ name: 'k', data: sshbuf.readBuffer() }];
  }
  throw new ApiError(400, `Unsupported PuTTY key type: ${algo}`, { code: 'KEY_UNSUPPORTED_FORMAT' });
}

/**
 * Parse a PKCS#1 (RSA/EC "traditional") or PKCS#8 (plain/encrypted) PEM
 * private key via Node's own `crypto.createPrivateKey` rather than sshpk.
 *
 * sshpk's PEM reader decrypts CBC-encrypted legacy PKCS#1/SEC1
 * (`Proc-Type: 4,ENCRYPTED`) and PBES2-encrypted PKCS#8 via a Node stream
 * (`Decipheriv` + `.once('error', ...)`); a bad-decrypt/padding error there
 * is emitted asynchronously (next tick) and its handler re-throws — which is
 * *not* catchable by a synchronous try/catch around the parse call and
 * crashes the process. `crypto.createPrivateKey` performs the equivalent
 * decryption synchronously (OpenSSL's native PEM reader) and throws a normal,
 * catchable error, so we use it for every PEM-ish input and only ever hand
 * sshpk an already-decrypted, unencrypted key.
 *
 * @param {string} text
 * @param {boolean} encrypted
 * @param {string} [passphrase]
 * @returns {sshpk.PrivateKey}
 */
function parseStandardPem(text, encrypted, passphrase) {
  if (encrypted && !passphrase) {
    throw new ApiError(
      400,
      'This private key is passphrase-protected; supply the passphrase to import it.',
      { code: 'KEY_PASSPHRASE_REQUIRED' }
    );
  }

  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(
      encrypted
        ? { key: text, format: 'pem', passphrase: Buffer.from(passphrase, 'utf8') }
        : { key: text, format: 'pem' }
    );
  } catch (err) {
    if (encrypted) {
      throw new ApiError(400, 'Incorrect passphrase for this private key.', {
        code: 'KEY_PASSPHRASE_INVALID',
      });
    }
    throw new ApiError(400, `Could not parse private key: ${err.message}`, {
      code: 'KEY_UNSUPPORTED_FORMAT',
    });
  }

  if (keyObject.asymmetricKeyType === 'dsa') {
    throw new ApiError(400, 'DSA keys are not supported (deprecated)', { code: 'KEY_UNSUPPORTED_TYPE' });
  }
  if (!['rsa', 'ec', 'ed25519'].includes(keyObject.asymmetricKeyType)) {
    throw new ApiError(400, `Unsupported key type: ${keyObject.asymmetricKeyType}`, {
      code: 'KEY_UNSUPPORTED_TYPE',
    });
  }

  // Re-export as plain (unencrypted) PKCS#8 — parsing THIS with sshpk never
  // touches its buggy decrypt-stream code path (there's nothing left to
  // decrypt), only its DER/part-extraction logic.
  const plainPkcs8 = keyObject.export({ type: 'pkcs8', format: 'pem' });
  try {
    return sshpk.parsePrivateKey(plainPkcs8, 'auto');
  } catch (err) {
    throw new ApiError(400, `Could not parse private key: ${err.message}`, {
      code: 'KEY_UNSUPPORTED_FORMAT',
    });
  }
}

/**
 * Parse/normalise an existing private key of any supported format (see file
 * header) into OpenSSH format. Never touches disk. If the input was
 * passphrase-protected, the output is re-encrypted with the SAME passphrase
 * (OpenSSH bcrypt KDF); otherwise the output is unencrypted.
 *
 * @param {object} params
 * @param {string} params.privateKey
 * @param {string} [params.passphrase]
 * @returns {Promise<{ privateKey, publicKey, fingerprint, keyType, bits, format, encrypted, comment }>}
 */
export async function normalizePrivateKey({ privateKey, passphrase }) {
  if (!privateKey || typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new ApiError(400, 'privateKey is required');
  }
  const pass = passphrase || undefined;
  const recovered = recoverKeyText(privateKey);
  const detected = detectFormat(recovered);

  if (!detected.format) {
    throw new ApiError(400, 'Unrecognized private key format', { code: 'KEY_UNSUPPORTED_FORMAT' });
  }

  let sshpkKey;
  let encrypted = detected.encrypted;
  let format = detected.format;

  if (format === 'ppk2' || format === 'ppk3') {
    const result = await readPuttyKey(recovered, pass);
    sshpkKey = result.key;
    encrypted = result.encrypted;
  } else if (format === 'openssh') {
    // OpenSSH's bcrypt-KDF decrypt path in sshpk throws synchronously
    // (a checkInt mismatch, not a stream 'error' event), so it's safe as-is.
    try {
      sshpkKey = sshpk.parsePrivateKey(recovered, 'auto', pass ? { passphrase: pass } : undefined);
    } catch (err) {
      if (err instanceof sshpk.KeyEncryptedError) {
        throw new ApiError(
          400,
          'This private key is passphrase-protected; supply the passphrase to import it.',
          { code: 'KEY_PASSPHRASE_REQUIRED' }
        );
      }
      if (/incorrect passphrase|bad decrypt|mac (check|verify) failure/i.test(err.message || '')) {
        throw new ApiError(400, 'Incorrect passphrase for this private key.', {
          code: 'KEY_PASSPHRASE_INVALID',
        });
      }
      throw new ApiError(400, `Could not parse private key: ${err.message}`, {
        code: 'KEY_UNSUPPORTED_FORMAT',
      });
    }
  } else {
    // pkcs1 | sec1 | pkcs8 (plain or encrypted)
    sshpkKey = parseStandardPem(recovered, encrypted, pass);
  }

  const keyType = sshpkKey.type === 'ecdsa' ? 'ecdsa' : sshpkKey.type;
  if (keyType === 'dsa') {
    throw new ApiError(400, 'DSA keys are not supported (deprecated)', { code: 'KEY_UNSUPPORTED_TYPE' });
  }
  if (!KEY_TYPES.includes(keyType)) {
    throw new ApiError(400, `Unsupported key type: ${sshpkKey.type}`, { code: 'KEY_UNSUPPORTED_TYPE' });
  }

  let publicKey;
  let fingerprint;
  try {
    const pub = sshpkKey.toPublic();
    publicKey = pub.toString('ssh').trim();
    fingerprint = pub.fingerprint('sha256').toString();
  } catch (err) {
    throw new ApiError(400, `Failed to derive public key: ${err.message}`, {
      code: 'KEY_UNSUPPORTED_FORMAT',
    });
  }

  const pkParts = publicKey.split(/\s+/);
  const comment = sshpkKey.comment || (pkParts.length > 2 ? pkParts.slice(2).join(' ') : '');

  let outPrivateKey;
  try {
    outPrivateKey = sshpkKey.toBuffer('ssh', pass ? { passphrase: pass } : undefined).toString('utf8');
  } catch (err) {
    throw new ApiError(400, `Failed to normalize private key: ${err.message}`, {
      code: 'KEY_UNSUPPORTED_FORMAT',
    });
  }

  return {
    privateKey: outPrivateKey,
    publicKey,
    fingerprint,
    keyType,
    bits: keyType === 'ed25519' ? null : sshpkKey.size,
    format,
    encrypted: !!encrypted,
    comment,
  };
}

/**
 * Legacy/simple import wrapper — same parsing as normalizePrivateKey() but
 * returns only the metadata shape the original (OpenSSH/PEM-only) helper
 * returned. Kept for callers that only need the derived public key info and
 * don't need the normalised OpenSSH text back (e.g. pre-validating an
 * as-typed key before it's stored verbatim elsewhere).
 * @param {object} params
 * @param {string} params.privateKey
 * @param {string} [params.passphrase]
 * @returns {Promise<{ keyType, bits, publicKey, fingerprint, comment }>}
 */
export async function importPrivateKey({ privateKey, passphrase }) {
  const normalized = await normalizePrivateKey({ privateKey, passphrase });
  return {
    keyType: normalized.keyType,
    bits: normalized.bits,
    publicKey: normalized.publicKey,
    fingerprint: normalized.fingerprint,
    comment: normalized.comment,
  };
}

// ---------------------------------------------------------------------------
// OpenSSH user certificates
// ---------------------------------------------------------------------------

/**
 * Parse an OpenSSH user/host certificate (`ssh-ed25519-cert-v01@openssh.com`
 * etc.) into a summary suitable for storage/display.
 * @param {string} text
 * @returns {{ type, keyId, principals, validAfter, validBefore, expired, caFingerprint, publicKeyFingerprint }}
 */
export function parseCertificate(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new ApiError(400, 'certificate is required', { code: 'CERT_INVALID' });
  }
  let cert;
  try {
    cert = sshpk.parseCertificate(text.trim(), 'openssh');
  } catch (err) {
    throw new ApiError(400, `Could not parse certificate: ${err.message}`, { code: 'CERT_INVALID' });
  }

  const opensshSig = (cert.signatures && cert.signatures.openssh) || {};
  const firstSubject = cert.subjects && cert.subjects[0];
  const type = firstSubject && firstSubject.type === 'host' ? 'host' : 'user';
  const principals = (cert.subjects || []).map((s) => s.uid || s.hostname || s.toString());

  let expired;
  try {
    expired = cert.isExpired();
  } catch {
    expired = null;
  }

  return {
    type,
    keyId: opensshSig.keyId || null,
    principals,
    validAfter: cert.validFrom,
    validBefore: cert.validUntil,
    expired,
    caFingerprint: cert.issuerKey ? cert.issuerKey.fingerprint('sha256').toString() : null,
    publicKeyFingerprint: cert.subjectKey.fingerprint('sha256').toString(),
  };
}

/**
 * Check whether a private-key-derived public key (as returned by
 * normalizePrivateKey/importPrivateKey — an object with `.publicKey`, or a
 * raw OpenSSH public key string) matches a given OpenSSH public key text.
 * @param {{publicKey:string}|string} privateInfo
 * @param {string} publicKeyText
 * @returns {boolean}
 */
export function publicKeyMatches(privateInfo, publicKeyText) {
  try {
    const a = fingerprintPublicKey(typeof privateInfo === 'string' ? privateInfo : privateInfo.publicKey);
    const b = fingerprintPublicKey(publicKeyText);
    return a === b;
  } catch {
    return false;
  }
}

export default {
  KEY_TYPES,
  RSA_BITS,
  ECDSA_BITS,
  isValidOpenSshPublicKey,
  fingerprintPublicKey,
  generateKeyPair,
  detectFormat,
  normalizePrivateKey,
  importPrivateKey,
  parseCertificate,
  publicKeyMatches,
};
