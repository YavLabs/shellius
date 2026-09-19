/**
 * sshConnect.js
 *
 * THE single outbound SSH engine for Shellius (ssh2). Every SSH connection the
 * backend makes — web terminal (certificate, credential and Quick Connect
 * modes), key deployment, credential tests and auto-provisioning — goes
 * through connectSsh() below. The OpenSSH `ssh` binary is never spawned.
 *
 * Responsibilities:
 *   - connectSsh(): open an ssh2 Client with certificate / key(+passphrase) /
 *     password / keyboard-interactive auth (in that order), computing the
 *     host key SHA256 fingerprint + algorithm via the hostVerifier hook.
 *   - The OpenSSH user-certificate auth patch (see "Certificate auth" below):
 *     ssh2@1.17.0's Protocol#authPK() writes the same algorithm name into both
 *     the userauth publickey-algorithm field AND the signature blob's
 *     algorithm field. For certificate auth those must differ (userauth field
 *     = the cert type, e.g. `ssh-ed25519-cert-v01@openssh.com`; signature
 *     blob = the base signing algorithm, e.g. `ssh-ed25519`) — sshd silently
 *     rejects the mismatched signature otherwise. We install a narrowly
 *     scoped override of Protocol.prototype.authPK that only activates for
 *     keys we've explicitly marked as carrying a certificate, and delegates
 *     to the original implementation for everything else (plain key auth,
 *     agent auth, hostbased auth are untouched).
 *   - resolveTarget(): DNS-resolve a host once and refuse loopback,
 *     link-local (incl. cloud metadata 169.254.169.254), unspecified and
 *     multicast addresses (TARGET_NOT_ALLOWED). RFC1918 private ranges are
 *     allowed. Connections are made to the resolved IP — never re-resolved —
 *     to avoid DNS-rebinding races between the check and the connect.
 *   - resolveServerAuth(): decrypt a Server's Credential (+ SshKey [+
 *     certificate]) into connect() options.
 *   - Host-key pinning helpers (TOFU): pin on first connect, refuse on
 *     mismatch until an admin resets the pin.
 *   - execCommand(): run a single command over an established connection.
 *
 * Security: decrypted secrets only ever live in local variables passed
 * straight into ssh2; nothing here logs key/password/certificate material.
 */

import { createRequire } from 'module';
import dns from 'dns/promises';
import net from 'net';

import { Client } from 'ssh2';
import sshpk from 'sshpk';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { decrypt } from '../utils/crypto.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Certificate auth — ssh2 Protocol#authPK() override
// ---------------------------------------------------------------------------

// ssh2 is pinned to this exact version in package.json. The override below
// pokes at module-private internals (Protocol.prototype, keyParser symbols)
// that are not part of ssh2's public API, so we hard-fail at import time if a
// different version sneaks in rather than silently sending broken cert auth.
const SUPPORTED_SSH2_VERSION = '1.17.0';

const CERT_MARKER = Symbol('shellius:sshCertAuth');

// Map OpenSSH certificate key-type names to the base (non-cert) signature
// algorithm to use for the signature blob, and (for RSA) a forced digest.
// ed25519 and ecdsa reuse the same signing path plain (non-cert) key auth
// already uses correctly in ssh2 (DER→SSH signature conversion via
// convertSignature keyed on this same base algorithm name) — only the wire
// algorithm *names* differ between cert and plain-key auth.
const CERT_BASE_ALGO = {
  'ssh-ed25519-cert-v01@openssh.com': { base: 'ssh-ed25519', hash: null },
  'ecdsa-sha2-nistp256-cert-v01@openssh.com': { base: 'ecdsa-sha2-nistp256', hash: null },
  'ecdsa-sha2-nistp384-cert-v01@openssh.com': { base: 'ecdsa-sha2-nistp384', hash: null },
  'ecdsa-sha2-nistp521-cert-v01@openssh.com': { base: 'ecdsa-sha2-nistp521', hash: null },
};

// RSA certs have no single correct signature algorithm: modern OpenSSH
// servers require RFC8332 rsa-sha2-256/512 (legacy ssh-rsa/SHA-1 is refused
// for cert auth by current sshd), and either digest may be required
// depending on the server's `PubkeyAcceptedAlgorithms`. ssh2 negotiates this
// itself for plain (non-cert) key auth using the server's `server-sig-algs`
// EXT_INFO extension (RFC8308) — a value that lives in a private closure
// inside Client#connect() with no public accessor. We best-effort capture it
// (see attachServerSigAlgsCapture below) to order these two variants by the
// server's stated preference; if that capture fails for any reason (ssh2
// internals changed, server omits EXT_INFO, capture timing lost the race),
// we still try both — 512 first, then 256 — via the normal auth-queue retry
// path (a USERAUTH_FAILURE that still lists 'publickey' in authsLeft means
// the *method* is fine and only that specific signature was rejected).
const RSA_CERT_TYPE = 'ssh-rsa-cert-v01@openssh.com';
const RSA_SIG_VARIANTS = [
  { base: 'rsa-sha2-512', hash: 'sha512' },
  { base: 'rsa-sha2-256', hash: 'sha256' },
];

let installCertAuthPatch;
let parseSsh2Key; // ssh2's own key parser — required so signing/prototype methods line up

(function initCertAuthPatch() {
  let Protocol;
  let parseKeyFn;
  let convertSignature;
  let sendPacket;
  let writeUInt32BE;
  let MESSAGE;
  let ssh2Version;

  try {
    ssh2Version = require('ssh2/package.json').version;
    Protocol = require('ssh2/lib/protocol/Protocol.js');
    ({ parseKey: parseKeyFn } = require('ssh2/lib/protocol/keyParser.js'));
    ({ convertSignature, sendPacket, writeUInt32BE } = require('ssh2/lib/protocol/utils.js'));
    ({ MESSAGE } = require('ssh2/lib/protocol/constants.js'));
  } catch (err) {
    throw new Error(
      `sshConnect: failed to load ssh2 internals required for OpenSSH certificate auth ` +
        `(expected ssh2@${SUPPORTED_SSH2_VERSION}): ${err.message}`
    );
  }

  if (ssh2Version !== SUPPORTED_SSH2_VERSION) {
    throw new Error(
      `sshConnect: ssh2@${ssh2Version} is installed, but the OpenSSH certificate-auth override ` +
        `was only written and verified against ssh2@${SUPPORTED_SSH2_VERSION}. Pin ssh2 to that ` +
        `exact version in package.json, or re-verify/update the override in sshConnect.js (see the ` +
        `"Certificate auth" comment at the top of this file) before deploying.`
    );
  }
  if (typeof Protocol?.prototype?.authPK !== 'function') {
    throw new Error('sshConnect: ssh2 internals look different than expected (Protocol.prototype.authPK missing) — refusing to install the certificate-auth patch.');
  }

  parseSsh2Key = parseKeyFn;

  installCertAuthPatch = () => {
    if (Protocol.prototype.__shelliusCertAuthPatched) return;

    const originalAuthPK = Protocol.prototype.authPK;

    Protocol.prototype.authPK = function patchedAuthPK(username, pubKey, keyAlgo, cbSign) {
      const marker = pubKey && pubKey[CERT_MARKER];
      if (!marker) {
        return originalAuthPK.call(this, username, pubKey, keyAlgo, cbSign);
      }

      if (this._server) throw new Error('Client-only method called in server mode');

      const parsed = parseKeyFn(pubKey);
      if (parsed instanceof Error) throw new Error('Invalid key');

      const certAlgoName = parsed.type; // e.g. ssh-ed25519-cert-v01@openssh.com
      const sigAlgoName = marker.baseAlgo; // e.g. ssh-ed25519
      const pubKeyBlob = parsed.getPublicSSH(); // cert wire blob (its own internal
      // type field is ALWAYS "ssh-rsa-cert-v01@openssh.com" for RSA — OpenSSH
      // only defines one wire cert format for RSA — regardless of which
      // signature digest is used.

      // RSA certs are the one case where the *negotiated userauth algorithm
      // name* (this function's `keyAlgo` parameter / the USERAUTH_REQUEST
      // "public key algorithm name" field) is NOT simply the cert's own type
      // (`certAlgoName` = "ssh-rsa-cert-v01@openssh.com"): RFC8332 defines
      // sibling names `rsa-sha2-256-cert-v01@openssh.com` /
      // `rsa-sha2-512-cert-v01@openssh.com` that tell the server which
      // digest to expect for the *same* cert blob. Modern sshd's default
      // PubkeyAcceptedAlgorithms drops the legacy ssh-rsa-cert-v01 (SHA-1)
      // name entirely, so sending that as `keyAlgo` gets an outright
      // USERAUTH_FAILURE even before a signature is attempted — we must
      // advertise the rsa-sha2-* cert name instead. ed25519/ecdsa have no
      // such split: their cert type name IS the (only) algorithm name.
      const rsaSha2CertName = sigAlgoName && sigAlgoName.startsWith('rsa-sha2-')
        ? `${sigAlgoName}-cert-v01@openssh.com`
        : null;
      const negotiatedAlgoName = rsaSha2CertName || certAlgoName;

      if (typeof keyAlgo === 'function') {
        cbSign = keyAlgo;
        keyAlgo = undefined;
      }
      if (!keyAlgo) keyAlgo = negotiatedAlgoName;

      const userLen = Buffer.byteLength(username);
      const algoLen = Buffer.byteLength(keyAlgo);
      const pubKeyLen = pubKeyBlob.length;
      const sessionID = this._kex.sessionID;
      const sesLen = sessionID.length;
      const payloadLen =
        (cbSign ? 4 + sesLen : 0)
          + 1 + 4 + userLen + 4 + 14 + 4 + 9 + 1 + 4 + algoLen + 4 + pubKeyLen;
      let packet;
      let p;
      if (cbSign) {
        packet = Buffer.allocUnsafe(payloadLen);
        p = 0;
        writeUInt32BE(packet, sesLen, p);
        packet.set(sessionID, p += 4);
        p += sesLen;
      } else {
        packet = this._packetRW.write.alloc(payloadLen);
        p = this._packetRW.write.allocStart;
      }

      packet[p] = MESSAGE.USERAUTH_REQUEST;
      writeUInt32BE(packet, userLen, ++p);
      packet.utf8Write(username, p += 4, userLen);
      writeUInt32BE(packet, 14, p += userLen);
      packet.utf8Write('ssh-connection', p += 4, 14);
      writeUInt32BE(packet, 9, p += 14);
      packet.utf8Write('publickey', p += 4, 9);
      packet[p += 9] = (cbSign ? 1 : 0);
      writeUInt32BE(packet, algoLen, ++p);
      packet.utf8Write(keyAlgo, p += 4, algoLen);
      writeUInt32BE(packet, pubKeyLen, p += algoLen);
      packet.set(pubKeyBlob, p += 4);

      if (!cbSign) {
        this._authsQueue.push('publickey');
        this._debug && this._debug('Outbound: Sending USERAUTH_REQUEST (publickey -- check) [cert]');
        sendPacket(this, this._packetRW.write.finalize(packet));
        return;
      }

      cbSign(packet, (signature) => {
        signature = convertSignature(signature, sigAlgoName);
        if (signature === false) throw new Error('Error while converting handshake signature');

        const sigAlgoLen = Buffer.byteLength(sigAlgoName);
        const sigLen = signature.length;
        p = this._packetRW.write.allocStart;
        packet = this._packetRW.write.alloc(
          1 + 4 + userLen + 4 + 14 + 4 + 9 + 1 + 4 + algoLen + 4 + pubKeyLen + 4
            + 4 + sigAlgoLen + 4 + sigLen
        );

        packet[p] = MESSAGE.USERAUTH_REQUEST;
        writeUInt32BE(packet, userLen, ++p);
        packet.utf8Write(username, p += 4, userLen);
        writeUInt32BE(packet, 14, p += userLen);
        packet.utf8Write('ssh-connection', p += 4, 14);
        writeUInt32BE(packet, 9, p += 14);
        packet.utf8Write('publickey', p += 4, 9);
        packet[p += 9] = 1;
        writeUInt32BE(packet, algoLen, ++p);
        packet.utf8Write(keyAlgo, p += 4, algoLen);
        writeUInt32BE(packet, pubKeyLen, p += algoLen);
        packet.set(pubKeyBlob, p += 4);

        // NOTE: this is the actual fix — the signature blob's own algorithm
        // name field uses the BASE algorithm (sigAlgoName), not the cert
        // type (keyAlgo), which is what stock ssh2@1.17.0 gets wrong.
        writeUInt32BE(packet, 4 + sigAlgoLen + 4 + sigLen, p += pubKeyLen);
        writeUInt32BE(packet, sigAlgoLen, p += 4);
        packet.utf8Write(sigAlgoName, p += 4, sigAlgoLen);
        writeUInt32BE(packet, sigLen, p += sigAlgoLen);
        packet.set(signature, p += 4);

        this._authsQueue.push('publickey');
        this._debug && this._debug('Outbound: Sending USERAUTH_REQUEST (publickey) [cert]');
        sendPacket(this, this._packetRW.write.finalize(packet));
      });
    };

    Protocol.prototype.__shelliusCertAuthPatched = true;
    logger.info('sshConnect: installed OpenSSH certificate-auth override for ssh2@' + ssh2Version);
  };
})();

installCertAuthPatch();

/**
 * Parse an OpenSSH certificate text ("<algo> <base64> [comment]") into its
 * algorithm name and raw wire-format blob.
 */
function parseCertificateText(certText) {
  const trimmed = String(certText || '').trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) throw new ApiError(400, 'Malformed certificate text');
  const [algoName, b64] = parts;
  const isRsaCert = algoName === RSA_CERT_TYPE;
  if (!CERT_BASE_ALGO[algoName] && !isRsaCert) {
    throw new ApiError(400, `Unsupported certificate type: ${algoName}`, { code: 'CERT_UNSUPPORTED_TYPE' });
  }
  let blob;
  try {
    blob = Buffer.from(b64, 'base64');
  } catch {
    throw new ApiError(400, 'Malformed certificate text');
  }
  if (!blob.length) throw new ApiError(400, 'Malformed certificate text');
  // Default baseInfo for RSA is the first (preferred) variant; buildAuthQueue
  // overrides it per-attempt when it queues both rsa-sha2-512/256 attempts.
  const baseInfo = isRsaCert ? RSA_SIG_VARIANTS[0] : CERT_BASE_ALGO[algoName];
  return { algoName, blob, baseInfo, isRsaCert };
}

/**
 * Build a "certified" key object ssh2 will treat as a normal parsed
 * publickey-auth key, except:
 *   - .type reports the CERTIFICATE algorithm (so the userauth request's
 *     publickey-algorithm field is correct)
 *   - .getPublicSSH() returns the certificate's wire blob (not the bare
 *     public key) — this is what actually gets sent as "the public key"
 *   - .sign() is pinned to the base algorithm's digest (relevant for RSA,
 *     where ssh2's server-negotiated rsa-sha2 selection lives in a closure
 *     we can't reach from here)
 *   - carries CERT_MARKER so our authPK patch (and only our patch) knows to
 *     use the base signature algorithm name for the signature blob.
 *
 * @param {string|Buffer} privateKey  - OpenSSH/PEM/PPK private key text
 * @param {string} [passphrase]
 * @param {string} certificate        - OpenSSH certificate text
 * @param {{base:string,hash:string|null}} [baseInfoOverride] - force a
 *   specific signature variant (used for RSA certs, where both
 *   rsa-sha2-512/256 are queued as separate auth attempts — see
 *   buildAuthQueue). Defaults to the certificate type's one true algorithm.
 * @returns {object} ssh2-compatible parsed key, usable as connect().privateKey
 */
function buildCertifiedKey(privateKey, passphrase, certificate, baseInfoOverride) {
  const parsedKey = parseSsh2Key(privateKey, passphrase);
  if (parsedKey instanceof Error) {
    const msg = /passphrase/i.test(parsedKey.message || '')
      ? 'Private key is encrypted and requires a passphrase, or the passphrase is incorrect'
      : `Could not parse private key: ${parsedKey.message}`;
    throw new ApiError(400, msg, { code: 'KEY_PASSPHRASE_INVALID' });
  }
  if (!parsedKey.isPrivateKey()) {
    throw new ApiError(400, 'certificate auth requires a private key, not a public key');
  }

  const { algoName, blob, baseInfo: defaultBaseInfo } = parseCertificateText(certificate);
  const baseInfo = baseInfoOverride || defaultBaseInfo;

  const wrapper = Object.create(parsedKey);
  wrapper.type = algoName;
  wrapper.getPublicSSH = () => blob;
  wrapper.sign = (data, algo) => parsedKey.sign(data, baseInfo.hash || algo);
  wrapper[CERT_MARKER] = { baseAlgo: baseInfo.base };
  return wrapper;
}

// ---------------------------------------------------------------------------
// Host key fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute { fingerprint, algorithm } from a raw SSH wire-format (rfc4253)
 * host public key blob, as handed to ssh2's hostVerifier.
 */
function describeHostKey(keyBuf) {
  const key = sshpk.parseKey(keyBuf, 'rfc4253');
  const fingerprint = key.fingerprint('sha256').toString(); // "SHA256:..."
  let algorithm;
  if (key.type === 'ecdsa') {
    algorithm = `ecdsa-sha2-${key.curve}`;
  } else if (key.type === 'ed25519') {
    algorithm = 'ssh-ed25519';
  } else if (key.type === 'rsa') {
    algorithm = 'ssh-rsa';
  } else {
    algorithm = key.type;
  }
  return { fingerprint, algorithm };
}

// ---------------------------------------------------------------------------
// Target guard — resolveTarget()
// ---------------------------------------------------------------------------

// Escape hatch for local dev, where Shellius itself commonly runs alongside
// throwaway SSH containers bound to 127.0.0.1. Off by default in every real
// deployment. See .env.example. Read live (not cached at import time) so
// tests can toggle it per-case.
function loopbackAllowed() {
  return String(process.env.SSH_TARGET_ALLOW_LOOPBACK || '').toLowerCase() === 'true';
}

/**
 * Classify a literal IPv4/IPv6 address.
 * @returns {'loopback'|'unspecified'|'linklocal'|'multicast'|'private'|'public'}
 */
export function classifyIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127) return 'loopback';
    if (o[0] === 0) return 'unspecified';
    if (o[0] === 169 && o[1] === 254) return 'linklocal'; // covers 169.254.169.254 cloud metadata
    if (o[0] >= 224 && o[0] <= 239) return 'multicast';
    if (o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255) return 'multicast'; // broadcast
    if (o[0] === 10) return 'private';
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 'private';
    if (o[0] === 192 && o[1] === 168) return 'private';
    return 'public';
  }
  if (fam === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'unspecified';
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'loopback';
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice(7);
      if (net.isIP(v4) === 4) return classifyIp(v4);
    }
    // fe80::/10
    if (/^fe[89ab]/.test(lower)) return 'linklocal';
    // ff00::/8
    if (lower.startsWith('ff')) return 'multicast';
    // fc00::/7 (unique local — "private" equivalent for IPv6)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
    return 'public';
  }
  return 'public';
}

/**
 * Resolve `host` (hostname or IP literal) to its address(es) exactly once,
 * and refuse targets in disallowed categories. RFC1918/ULA private ranges
 * are allowed (SSH targets are usually on private networks).
 *
 * @param {string} host
 * @returns {Promise<{ hostname: string, ip: string, addresses: string[] }>}
 *   `hostname` is the original input (for display); `ip` is the address to
 *   actually connect to (first resolved address); `addresses` is every
 *   resolved address, all of which were checked.
 */
const TARGET_DNS_TIMEOUT_MS = 8000;

export async function resolveTarget(host) {
  if (!host || typeof host !== 'string') {
    throw new ApiError(400, 'host is required');
  }

  let records;
  if (net.isIP(host)) {
    records = [{ address: host }];
  } else {
    // Time-boxed: a resolver that never answers should fail the request with
    // a clear error, not leave it hanging.
    let timer;
    try {
      records = await Promise.race([
        dns.lookup(host, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS lookup timed out')), TARGET_DNS_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      throw new ApiError(400, `Could not resolve host "${host}": ${err.message}`, { code: 'DNS_RESOLUTION_FAILED' });
    } finally {
      clearTimeout(timer);
    }
  }

  if (!records || records.length === 0) {
    throw new ApiError(400, `Could not resolve host "${host}"`, { code: 'DNS_RESOLUTION_FAILED' });
  }

  for (const { address } of records) {
    const category = classifyIp(address);
    if (category === 'loopback' && loopbackAllowed()) continue;
    if (category !== 'public' && category !== 'private') {
      throw new ApiError(
        403,
        `Target host "${host}" resolves to a disallowed address (${address} — ${category}).`,
        { code: 'TARGET_NOT_ALLOWED', details: { host, address, category } }
      );
    }
  }

  return { hostname: host, ip: records[0].address, addresses: records.map((r) => r.address) };
}

// ---------------------------------------------------------------------------
// Auth ordering — pure, unit-testable
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of ssh2 auth attempts for connectSsh(): certificate
 * → publickey → password → keyboard-interactive. Each present credential
 * contributes at most the attempts it enables; omitted ones are skipped
 * entirely (e.g. no privateKey ⇒ no publickey attempt).
 *
 * @returns {Array<{type: 'publickey'|'password'|'keyboard-interactive', username: string, [key]: any, [password]: string, [passphrase]: string}>}
 */
export function buildAuthQueue({ username, password, privateKey, passphrase, certificate }) {
  const queue = [];
  if (certificate && privateKey) {
    const { isRsaCert } = parseCertificateText(certificate);
    if (isRsaCert) {
      // Queue BOTH rsa-sha2-512 and rsa-sha2-256 as separate publickey
      // attempts (512 first by default). connectSsh() reorders these two
      // entries by the server's EXT_INFO server-sig-algs preference once
      // known (best-effort); either way, a USERAUTH_FAILURE that still
      // lists 'publickey' after the first attempt naturally advances to the
      // second — see pickNextAuth.
      for (const variant of RSA_SIG_VARIANTS) {
        queue.push({
          type: 'publickey',
          username,
          key: buildCertifiedKey(privateKey, passphrase, certificate, variant),
          rsaCertAlgo: variant.base,
        });
      }
    } else {
      queue.push({ type: 'publickey', username, key: buildCertifiedKey(privateKey, passphrase, certificate) });
    }
  }
  if (privateKey) {
    queue.push({ type: 'publickey', username, key: privateKey, passphrase });
  }
  if (password) {
    queue.push({ type: 'password', username, password });
    queue.push({ type: 'keyboard-interactive', username });
  }
  return queue;
}

/**
 * ssh2 authHandler step function: pop attempts off `queue` (mutating it)
 * until one whose `type` the server still accepts (`authsLeft`) is found, or
 * the queue is exhausted (`false`, meaning "give up"). `authsLeft` is
 * `undefined`/empty on the very first call (server hasn't rejected anything
 * yet); after a partial success it narrows to exactly what's still required
 * (e.g. `['password']` after publickey succeeded on a
 * `AuthenticationMethods publickey,password` server) — this is what makes
 * "needs both a key and a password" work without hardcoding the pair.
 *
 * @param {Array<object>} queue      - mutated (shifted) in place
 * @param {string[]} [authsLeft]
 * @returns {object|false}
 */
export function pickNextAuth(queue, authsLeft) {
  while (queue.length) {
    const next = queue.shift();
    if (Array.isArray(authsLeft) && authsLeft.length && !authsLeft.includes(next.type)) {
      continue;
    }
    return next;
  }
  return false;
}

/**
 * Reorder the (still-queued, not-yet-attempted) RSA-cert auth-queue entries
 * — tagged `rsaCertAlgo` by buildAuthQueue — so the one matching the
 * server's advertised `server-sig-algs` preference (RFC8308 EXT_INFO, when
 * captured — see attachServerSigAlgsCapture) is tried first. Every other
 * queue entry (plain key, password, keyboard-interactive, and any RSA
 * variant the server didn't list) keeps its original relative position.
 * Pure/idempotent — mutates `queue` in place; safe to call unconditionally.
 *
 * @param {Array<object>} queue
 * @param {string[]|null|undefined} serverSigAlgs
 */
export function reorderRsaCertAttempts(queue, serverSigAlgs) {
  if (!Array.isArray(serverSigAlgs) || serverSigAlgs.length === 0) return;

  const slots = [];
  const entries = [];
  queue.forEach((entry, index) => {
    if (entry && entry.rsaCertAlgo) {
      slots.push(index);
      entries.push(entry);
    }
  });
  if (entries.length < 2) return;

  const rank = (algo) => {
    const idx = serverSigAlgs.indexOf(algo);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  entries.sort((a, b) => rank(a.rsaCertAlgo) - rank(b.rsaCertAlgo));
  slots.forEach((queueIndex, i) => {
    queue[queueIndex] = entries[i];
  });
}

/**
 * Best-effort: wrap the EXT_INFO message handler ssh2 installs on this
 * connection's Protocol instance (`conn._protocol._handlers.EXT_INFO`) so we
 * can also read the `server-sig-algs` extension (RFC8308) it already parses
 * internally for plain-key auth negotiation, but keeps in a private closure
 * with no public accessor. Only wraps this one connection's handler function
 * (no Protocol.prototype patching, no cross-connection state) — if ssh2's
 * internals don't match the expected shape, this silently does nothing and
 * RSA cert auth falls back to trying both rsa-sha2-512 and rsa-sha2-256 (see
 * reorderRsaCertAttempts / buildAuthQueue).
 *
 * @param {import('ssh2').Client} conn
 * @param {{ serverSigAlgs: string[]|null }} state - mutated when captured
 */
function attachServerSigAlgsCapture(conn, state) {
  try {
    const handlers = conn && conn._protocol && conn._protocol._handlers;
    const original = handlers && handlers.EXT_INFO;
    if (typeof original !== 'function') return;
    handlers.EXT_INFO = (p, exts) => {
      try {
        if (Array.isArray(exts)) {
          const ext = exts.find((e) => e && e.name === 'server-sig-algs');
          if (ext && Array.isArray(ext.algs)) state.serverSigAlgs = ext.algs;
        }
      } catch {
        // best-effort only
      }
      return original(p, exts);
    };
  } catch {
    // best-effort only — RSA cert auth still works via the try-both fallback.
  }
}

// ---------------------------------------------------------------------------
// connectSsh
// ---------------------------------------------------------------------------

/**
 * Open an ssh2 connection. Auth order: certificate (key+certificate) →
 * publickey (key alone) → password → keyboard-interactive (answers prompts
 * containing "password" with the password). Servers requiring BOTH a key and
 * a password (`AuthenticationMethods publickey,password`) are supported via
 * ssh2's authHandler function form, which reacts to SSH partial success.
 *
 * @param {object} opts
 * @param {string} opts.host                 - hostname OR resolved IP; NOT re-resolved here
 * @param {number} [opts.port=22]
 * @param {string} opts.username
 * @param {string} [opts.password]
 * @param {string|Buffer} [opts.privateKey]
 * @param {string} [opts.passphrase]
 * @param {string} [opts.certificate]         - OpenSSH cert text; requires privateKey
 * @param {string} [opts.expectedFingerprint] - "SHA256:...". If set and the presented host key doesn't match, the connection is refused.
 * @param {string} [opts.pinContext]          - free-form label for logs (e.g. serverId) — not sent over the wire
 * @param {(info: {fingerprint:string, algorithm:string}) => void} [opts.onHostKey]
 * @param {number} [opts.readyTimeout=15000]
 * @returns {Promise<{ client: import('ssh2').Client, hostKey: {fingerprint:string, algorithm:string} }>}
 */
export function connectSsh({
  host,
  port = 22,
  username,
  password,
  privateKey,
  passphrase,
  certificate,
  expectedFingerprint,
  pinContext,
  onHostKey,
  readyTimeout = 15000,
} = {}) {
  if (!host) throw new ApiError(400, 'host is required');
  if (!username) throw new ApiError(400, 'username is required');
  if (!password && !privateKey) {
    throw new ApiError(400, 'Either a password or a private key is required');
  }
  if (certificate && !privateKey) {
    throw new ApiError(400, 'certificate requires a matching privateKey');
  }

  // Ordered list of auth attempts. ssh2's authHandler function form is called
  // every time the server responds with USERAUTH_FAILURE, with the set of
  // methods it still accepts (authsLeft) and whether a partial success just
  // happened — this is what lets us satisfy `AuthenticationMethods
  // publickey,password` without hardcoding a fixed pair of attempts.
  let queue;
  try {
    queue = buildAuthQueue({ username, password, privateKey, passphrase, certificate });
  } catch (err) {
    return Promise.reject(err instanceof ApiError ? err : new ApiError(400, err.message));
  }

  // Best-effort capture of the server's `server-sig-algs` EXT_INFO extension
  // (see attachServerSigAlgsCapture) — reorders any queued RSA-cert auth
  // attempts to try the server-preferred rsa-sha2-256/512 variant first. Only
  // applied once, before the first auth attempt is popped; if the capture
  // never fires (no EXT_INFO, or ssh2 internals didn't match), both variants
  // are still tried in the default (512-first) order via the normal
  // USERAUTH_FAILURE retry path.
  const extInfoState = { serverSigAlgs: null };
  let rsaOrderApplied = false;
  const authHandler = (authsLeft) => {
    if (!rsaOrderApplied) {
      rsaOrderApplied = true;
      reorderRsaCertAttempts(queue, extInfoState.serverSigAlgs);
    }
    return pickNextAuth(queue, authsLeft);
  };

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let hostKeyInfo = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      try { conn.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve({ client: conn, hostKey: hostKeyInfo });
    });

    conn.on('error', (err) => {
      fail(mapSshError(err, host, port));
    });

    if (password) {
      conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        // Most keyboard-interactive setups present a single "Password:"
        // prompt; answer that (and any other prompt whose text mentions
        // "password") with the password, everything else with an empty
        // response rather than guessing.
        finish(prompts.map((pr) => (prompts.length === 1 || /password/i.test(pr?.prompt || '') ? password : '')));
      });
    }

    let connectOpts;
    try {
      connectOpts = {
        host,
        port,
        username,
        authHandler,
        readyTimeout,
        hostVerifier: (keyBuf, verify) => {
          try {
            hostKeyInfo = describeHostKey(keyBuf);
          } catch (err) {
            logger.warn('sshConnect: failed to parse host key', { host, pinContext, error: err.message });
            verify(false);
            return;
          }
          if (onHostKey) {
            try { onHostKey(hostKeyInfo); } catch { /* ignore */ }
          }
          if (expectedFingerprint && expectedFingerprint !== hostKeyInfo.fingerprint) {
            verify(false);
            return;
          }
          verify(true);
        },
      };
    } catch (err) {
      fail(err);
      return;
    }

    try {
      conn.connect(connectOpts);
      attachServerSigAlgsCapture(conn, extInfoState);
    } catch (err) {
      fail(mapSshError(err, host, port));
    }
  });
}

/**
 * Run a single command over an established ssh2 connection and collect
 * stdout/stderr. Optionally writes `stdin` to the command's stdin stream
 * (used to feed a sudo password or a public key body without ever putting
 * it on the command line).
 *
 * @param {import('ssh2').Client} client
 * @param {string} cmd
 * @param {{ stdin?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string }>}
 */
export function execCommand(client, cmd, { stdin, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      timer = setTimeout(() => {
        try { stream.close(); } catch { /* ignore */ }
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      stream.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? null, signal: signal ?? null, stdout, stderr });
      });
      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      stream.on('error', (streamErr) => {
        clearTimeout(timer);
        reject(streamErr);
      });

      if (stdin !== undefined) {
        stream.end(stdin);
      } else {
        stream.end();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// resolveServerAuth — decrypt a server's Credential (+ SshKey) into connect opts
// ---------------------------------------------------------------------------

/**
 * Load and decrypt the auth material for a credential-mode server.
 *
 * @param {object} server  - Prisma Server row, must include `credential` with
 *   its `sshKey` relation (or will be loaded here if missing).
 * @returns {Promise<{ host: string, port: number, username: string, password?: string, privateKey?: string, passphrase?: string, certificate?: string }>}
 */
export async function resolveServerAuth(server) {
  if (!server) throw new ApiError(404, 'Server not found');
  if (server.authMode !== 'credential') {
    throw new ApiError(400, 'Server is not in credential auth mode');
  }

  let credential = server.credential;
  if (!credential && server.credentialId) {
    credential = await prisma.credential.findFirst({
      where: { id: server.credentialId, orgId: server.orgId, ownerId: null },
      include: { sshKey: true },
    });
  }
  if (!credential) {
    throw new ApiError(400, 'This server has no identity (Credential) configured');
  }

  const opts = {
    host: server.ipAddress || server.hostname,
    port: server.port || 22,
    username: credential.username,
  };

  if (credential.passwordEncrypted && (credential.authType === 'password' || credential.authType === 'key_password')) {
    opts.password = decrypt(credential.passwordEncrypted);
  }
  if (credential.sshKey && (credential.authType === 'key' || credential.authType === 'key_password')) {
    opts.privateKey = decrypt(credential.sshKey.privateKeyEncrypted);
    if (credential.sshKey.passphraseEncrypted) {
      opts.passphrase = decrypt(credential.sshKey.passphraseEncrypted);
    }
    if (credential.sshKey.certificate) {
      opts.certificate = credential.sshKey.certificate;
    }
  }

  if (!opts.password && !opts.privateKey) {
    throw new ApiError(400, 'This identity has no usable password or key configured');
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Host-key pinning (TOFU)
// ---------------------------------------------------------------------------

/**
 * TOFU pinning: if the server has no pinned host key yet, pin the one just
 * seen. If it has one, refuse (ApiError code HOST_KEY_MISMATCH) when it
 * doesn't match. Returns the effective status: 'pinned' | 'matched'.
 *
 * @param {object} server        - Server row (id, orgId, hostKeyFingerprint, hostKeyAlgorithm)
 * @param {{fingerprint:string, algorithm:string}} hostKey
 * @returns {Promise<'pinned'|'matched'>}
 */
export async function checkAndPinHostKey(server, hostKey) {
  if (!server.hostKeyFingerprint) {
    await prisma.server.update({
      where: { id: server.id },
      data: {
        hostKeyFingerprint: hostKey.fingerprint,
        hostKeyAlgorithm: hostKey.algorithm,
        hostKeyPinnedAt: new Date(),
      },
    });
    logger.info('sshConnect: host key pinned (TOFU)', {
      serverId: server.id,
      fingerprint: hostKey.fingerprint,
    });
    return 'pinned';
  }

  if (server.hostKeyFingerprint !== hostKey.fingerprint) {
    throw new ApiError(
      409,
      `Host key mismatch for ${server.hostname || server.id}: expected ${server.hostKeyFingerprint}, got ${hostKey.fingerprint}. ` +
        'The host key changed — this could indicate a MITM attack or a reinstalled host. An admin must reset the pinned key to proceed.',
      { code: 'HOST_KEY_MISMATCH', details: { expected: server.hostKeyFingerprint, actual: hostKey.fingerprint } }
    );
  }

  return 'matched';
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export function mapSshError(err, host, port) {
  const code = err?.code;
  const lvl = err?.level;
  let message;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    message = `DNS lookup failed for ${host}.`;
  } else if (code === 'ECONNREFUSED') {
    message = `Connection refused at ${host}:${port}.`;
  } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    message = `${host} is not reachable.`;
  } else if (code === 'ETIMEDOUT' || /timed?\s*out/i.test(err?.message || '')) {
    message = `Timed out connecting to ${host}:${port}.`;
  } else if (lvl === 'client-authentication' || /all configured authentication methods failed/i.test(err?.message || '')) {
    message = `SSH authentication failed at ${host}.`;
  } else if (err?.code === 'HOST_KEY_MISMATCH' || /host denied/i.test(err?.message || '')) {
    message = `Host key verification failed for ${host}.`;
  } else {
    message = `SSH error connecting to ${host}:${port} — ${err?.message || 'unknown error'}`;
  }
  const wrapped = new ApiError(502, message, { code: 'SSH_CONNECT_FAILED' });
  wrapped.cause = err;
  return wrapped;
}

export default {
  connectSsh,
  execCommand,
  resolveServerAuth,
  checkAndPinHostKey,
  mapSshError,
  resolveTarget,
  classifyIp,
  buildAuthQueue,
  pickNextAuth,
  reorderRsaCertAttempts,
};
