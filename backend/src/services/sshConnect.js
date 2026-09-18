/**
 * sshConnect.js
 *
 * Shared ssh2 connection helper for the Keystore / Quick Connect / Key
 * Deployment flows (as opposed to the certificate-based path, which shells
 * out to the OpenSSH client — see terminalService.js for why).
 *
 * Responsibilities:
 *   - connectSsh(): open an ssh2 Client with password / key(+passphrase) /
 *     keyboard-interactive auth, computing the host key SHA256 fingerprint
 *     + algorithm via the hostVerifier hook.
 *   - resolveServerAuth(): decrypt a Server's Credential (+ SshKey) into
 *     connect() options.
 *   - Host-key pinning helpers (TOFU): pin on first connect, refuse on
 *     mismatch until an admin resets the pin.
 *   - execCommand(): run a single command over an established connection.
 *
 * Security: decrypted secrets only ever live in local variables passed
 * straight into ssh2; nothing here logs key/password material.
 */

import { Client } from 'ssh2';
import sshpk from 'sshpk';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { decrypt } from '../utils/crypto.js';

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
// connectSsh
// ---------------------------------------------------------------------------

/**
 * Open an ssh2 connection with password / private-key(+passphrase) auth.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=22]
 * @param {string} opts.username
 * @param {string} [opts.password]
 * @param {string|Buffer} [opts.privateKey]
 * @param {string} [opts.passphrase]
 * @param {string} [opts.expectedFingerprint]  - "SHA256:...". If set and the
 *   presented host key doesn't match, the connection is refused.
 * @param {(info: {fingerprint:string, algorithm:string}) => void} [opts.onHostKey]
 *   Called as soon as the host key is seen (before auth completes).
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
  expectedFingerprint,
  onHostKey,
  readyTimeout = 15000,
} = {}) {
  if (!host) throw new ApiError(400, 'host is required');
  if (!username) throw new ApiError(400, 'username is required');
  if (!password && !privateKey) {
    throw new ApiError(400, 'Either a password or a private key is required');
  }

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
        finish(prompts.map(() => password));
      });
    }

    const authMethods = [];
    if (privateKey) authMethods.push({ type: 'publickey', username, key: privateKey, passphrase });
    if (password) {
      authMethods.push({ type: 'password', username, password });
      authMethods.push({ type: 'keyboard-interactive', username });
    }

    let connectOpts;
    try {
      connectOpts = {
        host,
        port,
        username,
        ...(privateKey ? { privateKey, passphrase } : {}),
        ...(password ? { password } : {}),
        tryKeyboard: !!password,
        ...(authMethods.length ? { authHandler: authMethods } : {}),
        readyTimeout,
        hostVerifier: (keyBuf, verify) => {
          try {
            hostKeyInfo = describeHostKey(keyBuf);
          } catch (err) {
            logger.warn('sshConnect: failed to parse host key', { host, error: err.message });
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
 * @returns {Promise<{ host: string, port: number, username: string, password?: string, privateKey?: string, passphrase?: string }>}
 */
export async function resolveServerAuth(server) {
  if (!server) throw new ApiError(404, 'Server not found');
  if (server.authMode !== 'credential') {
    throw new ApiError(400, 'Server is not in credential auth mode');
  }

  let credential = server.credential;
  if (!credential && server.credentialId) {
    credential = await prisma.credential.findUnique({
      where: { id: server.credentialId },
      include: { sshKey: true },
    });
  }
  if (!credential) {
    throw new ApiError(400, 'This server has no identity (Credential) configured');
  }
  if (credential.authType !== 'key' && !credential.sshKey) {
    // password | key_password both may carry an sshKey; only 'password' never does
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
};
