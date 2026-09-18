#!/usr/bin/env node
/**
 * e2e-ssh-engine.mjs
 *
 * End-to-end proof that sshConnect.js's single ssh2 engine actually talks to
 * a real sshd correctly — in particular that the OpenSSH user-certificate
 * auth patch produces a signature sshd accepts, which is the one thing that
 * can't be verified with mocks.
 *
 * NOT part of `npm test` (jest). Run explicitly: `npm run test:e2e:ssh`.
 *
 * Requires two throwaway sshd containers/ports:
 *   1. SSH_E2E_HOST:SSH_E2E_PORT (default 127.0.0.1:52223) — trusts a CA
 *      whose private key is at SSH_E2E_CA_KEY (TrustedUserCAKeys), and has a
 *      user SSH_E2E_USER with SSH_E2E_PASSWORD set and the key at
 *      SSH_E2E_USER_KEY.pub authorized.
 *   2. SSH_E2E_HOST:SSH_E2E_BOTH_PORT (default 127.0.0.1:52224) — a second,
 *      separate instance whose sshd_config sets a global
 *      `AuthenticationMethods publickey,password`, with the same key
 *      authorized and the same password, for SSH_E2E_BOTH_USER (defaults to
 *      SSH_E2E_USER). A *separate instance* is used rather than a
 *      same-container second Linux user + `Match User` block because the
 *      linuxserver/openssh-server image's single-user sandbox silently
 *      refuses pubkey auth for any account other than its designated one.
 *
 * Normally run via scripts/e2e-ssh.sh (npm run test:e2e:ssh), which builds
 * all fixtures and containers from scratch and tears them down afterwards.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';

import * as sshConnect from '../src/services/sshConnect.js';

const HOST = process.env.SSH_E2E_HOST || '127.0.0.1';
const PORT = parseInt(process.env.SSH_E2E_PORT || '52223', 10);
const USER = process.env.SSH_E2E_USER || 'deploy';
const PASSWORD = process.env.SSH_E2E_PASSWORD || 'E2ePass!2026';
// Separate throwaway instance (own container/port) with a *global*
// `AuthenticationMethods publickey,password` — see file header. Using a
// second instance instead of a same-container second OS user because the
// linuxserver/openssh-server image's single-user sandbox silently refuses
// pubkey auth for any account other than its designated one.
const BOTH_PORT = parseInt(process.env.SSH_E2E_BOTH_PORT || '52224', 10);
const BOTH_USER = process.env.SSH_E2E_BOTH_USER || USER;

const FIXTURE_DIR = process.env.SSH_E2E_FIXTURE_DIR || path.join(os.tmpdir(), 'shellius-e2e');
const CA_KEY_PATH = process.env.SSH_E2E_CA_KEY || path.join(FIXTURE_DIR, 'ca_key');
const USER_KEY_PATH = process.env.SSH_E2E_USER_KEY || path.join(FIXTURE_DIR, 'user_key');
const USER_PUB_PATH = `${USER_KEY_PATH}.pub`;

// ── RSA/ECDSA certificate-auth fixtures (Revision 2) ────────────────────────
// Same PORT/container (shellius-e2e-cert) additionally trusts a second, RSA
// CA (RSA_CA_KEY) — proves cert auth works when signed by either CA type —
// and has RSA/ECDSA user keys authorized. CERT256_PORT points at a second
// container whose sshd_config restricts `PubkeyAcceptedAlgorithms` to
// `rsa-sha2-256-cert-v01@openssh.com` only, trusting just the RSA CA — this
// is what actually proves rsa-sha2-256 negotiation (not just a lucky 512
// success) rather than a hardcoded/forced digest.
const RSA_CA_KEY_PATH = process.env.SSH_E2E_RSA_CA_KEY || path.join(FIXTURE_DIR, 'rsa_ca_key');
const RSA_USER_KEY_PATH = process.env.SSH_E2E_RSA_USER_KEY || path.join(FIXTURE_DIR, 'rsa_user_key');
const RSA_USER_PUB_PATH = `${RSA_USER_KEY_PATH}.pub`;
const CERT256_PORT = parseInt(process.env.SSH_E2E_CERT256_PORT || '52225', 10);
const ECDSA_BITS = [256, 384, 521];
function ecdsaKeyPath(bits) {
  return process.env[`SSH_E2E_ECDSA_${bits}_KEY`] || path.join(FIXTURE_DIR, `ecdsa_${bits}_key`);
}

let pass = 0;
let fail = 0;

async function t(name, fn) {
  process.stdout.write(`- ${name} ... `);
  try {
    await fn();
    pass += 1;
    console.log('OK');
  } catch (err) {
    fail += 1;
    console.log('FAIL');
    console.error(`  ${err.stack || err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function main() {
  console.log(`e2e-ssh-engine: target ${HOST}:${PORT}, ca=${CA_KEY_PATH}, key=${USER_KEY_PATH}`);

  if (!fs.existsSync(CA_KEY_PATH) || !fs.existsSync(USER_KEY_PATH)) {
    console.error(`Fixture files missing (CA key: ${CA_KEY_PATH}, user key: ${USER_KEY_PATH}). See file header for how to build the fixture.`);
    process.exit(2);
  }

  const privateKey = fs.readFileSync(USER_KEY_PATH, 'utf8');

  // Sign a fresh short-lived cert for this run.
  execFileSync('ssh-keygen', [
    '-s', CA_KEY_PATH,
    '-I', `shellius-e2e-${Date.now()}`,
    '-n', USER,
    '-V', '+5m',
    USER_PUB_PATH,
  ], { stdio: 'pipe' });
  const certPath = USER_PUB_PATH.replace(/\.pub$/, '-cert.pub');
  const certificate = fs.readFileSync(certPath, 'utf8');

  // ── 1. ed25519 certificate login ──────────────────────────────────────
  await t('certificate auth (ed25519 CA cert)', async () => {
    const { client, hostKey } = await sshConnect.connectSsh({
      host: HOST, port: PORT, username: USER, privateKey, certificate, readyTimeout: 10000,
    });
    assert(hostKey && hostKey.fingerprint.startsWith('SHA256:'), 'expected a host key fingerprint');
    const result = await sshConnect.execCommand(client, 'echo shellius-e2e-cert-ok && whoami');
    client.end();
    assert(result.code === 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
    assert(/shellius-e2e-cert-ok/.test(result.stdout), 'expected marker in stdout');
    assert(new RegExp(USER).test(result.stdout), `expected whoami to report ${USER}`);
  });

  // ── 2. plain key login (no certificate) ─────────────────────────────────
  await t('plain publickey auth (no certificate)', async () => {
    const { client } = await sshConnect.connectSsh({
      host: HOST, port: PORT, username: USER, privateKey, readyTimeout: 10000,
    });
    const result = await sshConnect.execCommand(client, 'echo shellius-e2e-key-ok');
    client.end();
    assert(result.code === 0 && /shellius-e2e-key-ok/.test(result.stdout), 'plain key auth failed');
  });

  // ── 2b. RSA certificate auth — proper rsa-sha2-512/256 negotiation ─────
  // (Revision 2: sshConnect.js no longer forces rsa-sha2-512 unconditionally
  // — it queues both variants, best-effort-orders them by the server's
  // EXT_INFO server-sig-algs, and falls back to trying both on
  // USERAUTH_FAILURE.)
  if (fs.existsSync(RSA_CA_KEY_PATH) && fs.existsSync(RSA_USER_KEY_PATH)) {
    const rsaPrivateKey = fs.readFileSync(RSA_USER_KEY_PATH, 'utf8');

    const signRsaCert = (caKeyPath, label) => {
      execFileSync('ssh-keygen', [
        '-s', caKeyPath, '-I', `shellius-e2e-rsa-${label}-${Date.now()}`,
        '-n', USER, '-V', '+5m', RSA_USER_PUB_PATH,
      ], { stdio: 'pipe' });
      const p = RSA_USER_PUB_PATH.replace(/\.pub$/, '-cert.pub');
      return fs.readFileSync(p, 'utf8');
    };

    await t('RSA certificate auth, signed by an ed25519 CA (default/unrestricted server)', async () => {
      const certificate = signRsaCert(CA_KEY_PATH, 'ed25519ca');
      const { client } = await sshConnect.connectSsh({
        host: HOST, port: PORT, username: USER, privateKey: rsaPrivateKey, certificate, readyTimeout: 10000,
      });
      const result = await sshConnect.execCommand(client, 'echo shellius-e2e-rsa-ed25519ca-ok');
      client.end();
      assert(result.code === 0 && /shellius-e2e-rsa-ed25519ca-ok/.test(result.stdout), 'RSA cert (ed25519 CA) auth failed');
    });

    if (fs.existsSync(`${RSA_CA_KEY_PATH}.pub`) || fs.existsSync(RSA_CA_KEY_PATH)) {
      await t('RSA certificate auth, signed by an RSA CA (default/unrestricted server)', async () => {
        const certificate = signRsaCert(RSA_CA_KEY_PATH, 'rsaca');
        const { client } = await sshConnect.connectSsh({
          host: HOST, port: PORT, username: USER, privateKey: rsaPrivateKey, certificate, readyTimeout: 10000,
        });
        const result = await sshConnect.execCommand(client, 'echo shellius-e2e-rsa-rsaca-ok');
        client.end();
        assert(result.code === 0 && /shellius-e2e-rsa-rsaca-ok/.test(result.stdout), 'RSA cert (RSA CA) auth failed');
      });

      await t('RSA certificate auth negotiates rsa-sha2-256 against a server restricted to it', async () => {
        const certificate = signRsaCert(RSA_CA_KEY_PATH, 'rsaca-256');
        const { client } = await sshConnect.connectSsh({
          host: HOST, port: CERT256_PORT, username: USER, privateKey: rsaPrivateKey, certificate, readyTimeout: 10000,
        });
        const result = await sshConnect.execCommand(client, 'echo shellius-e2e-rsa-256-ok');
        client.end();
        assert(result.code === 0 && /shellius-e2e-rsa-256-ok/.test(result.stdout), 'RSA cert rsa-sha2-256-only negotiation failed');
      });
    } else {
      console.log('  (skip RSA-CA-signed cases: RSA CA fixture not found)');
    }
  } else {
    console.log('- RSA certificate auth ... SKIP (fixture missing: set SSH_E2E_RSA_CA_KEY / SSH_E2E_RSA_USER_KEY)');
  }

  // ── 2c. ECDSA certificate auth (nistp256/384/521) ──────────────────────
  for (const bits of ECDSA_BITS) {
    const keyPath = ecdsaKeyPath(bits);
    if (!fs.existsSync(keyPath)) {
      console.log(`- ECDSA nistp${bits} certificate auth ... SKIP (fixture missing: ${keyPath})`);
      continue;
    }
    await t(`ECDSA nistp${bits} certificate auth`, async () => {
      const ecdsaPrivateKey = fs.readFileSync(keyPath, 'utf8');
      execFileSync('ssh-keygen', [
        '-s', CA_KEY_PATH, '-I', `shellius-e2e-ecdsa-${bits}-${Date.now()}`,
        '-n', USER, '-V', '+5m', `${keyPath}.pub`,
      ], { stdio: 'pipe' });
      const certificate = fs.readFileSync(`${keyPath}`.replace(/$/, '') + '-cert.pub', 'utf8');
      const { client } = await sshConnect.connectSsh({
        host: HOST, port: PORT, username: USER, privateKey: ecdsaPrivateKey, certificate, readyTimeout: 10000,
      });
      const result = await sshConnect.execCommand(client, `echo shellius-e2e-ecdsa-${bits}-ok`);
      client.end();
      assert(result.code === 0 && new RegExp(`shellius-e2e-ecdsa-${bits}-ok`).test(result.stdout), `ECDSA nistp${bits} cert auth failed`);
    });
  }

  // ── 3. password login ────────────────────────────────────────────────
  await t('password auth', async () => {
    const { client } = await sshConnect.connectSsh({
      host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 10000,
    });
    const result = await sshConnect.execCommand(client, 'echo shellius-e2e-pw-ok');
    client.end();
    assert(result.code === 0 && /shellius-e2e-pw-ok/.test(result.stdout), 'password auth failed');
  });

  // ── 4. key + password (SSH partial success — AuthenticationMethods) ────
  await t('key + password (server requires both)', async () => {
    const { client } = await sshConnect.connectSsh({
      host: HOST, port: BOTH_PORT, username: BOTH_USER, privateKey, password: PASSWORD, readyTimeout: 10000,
    });
    const result = await sshConnect.execCommand(client, 'echo shellius-e2e-both-ok');
    client.end();
    assert(result.code === 0 && /shellius-e2e-both-ok/.test(result.stdout), 'key+password (partial success) auth failed');
  });

  await t('key-only against a both-required account is refused', async () => {
    let threw = false;
    try {
      const { client } = await sshConnect.connectSsh({
        host: HOST, port: BOTH_PORT, username: BOTH_USER, privateKey, readyTimeout: 8000,
      });
      client.end();
    } catch {
      threw = true;
    }
    assert(threw, 'expected key-only auth against a publickey+password account to fail');
  });

  // ── 5. host key pin + mismatch ──────────────────────────────────────────
  let pinnedFingerprint;
  await t('host key pin (first sight, no expectedFingerprint)', async () => {
    const { client, hostKey } = await sshConnect.connectSsh({
      host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 10000,
    });
    client.end();
    pinnedFingerprint = hostKey.fingerprint;
    assert(pinnedFingerprint, 'expected a host key fingerprint to pin');
  });

  await t('host key matches expectedFingerprint', async () => {
    const { client } = await sshConnect.connectSsh({
      host: HOST, port: PORT, username: USER, password: PASSWORD,
      expectedFingerprint: pinnedFingerprint, readyTimeout: 10000,
    });
    client.end();
  });

  await t('host key mismatch is refused', async () => {
    let threw = false;
    try {
      const { client } = await sshConnect.connectSsh({
        host: HOST, port: PORT, username: USER, password: PASSWORD,
        expectedFingerprint: 'SHA256:0000000000000000000000000000000000000000A',
        readyTimeout: 8000,
      });
      client.end();
    } catch {
      threw = true;
    }
    assert(threw, 'expected a mismatched host key fingerprint to be refused');
  });

  // ── 6. resolveTarget guard sanity (no network needed) ───────────────────
  await t('resolveTarget refuses loopback by default', async () => {
    const prev = process.env.SSH_TARGET_ALLOW_LOOPBACK;
    delete process.env.SSH_TARGET_ALLOW_LOOPBACK;
    let threw = false;
    try {
      await sshConnect.resolveTarget('127.0.0.1');
    } catch (err) {
      threw = err.code === 'TARGET_NOT_ALLOWED';
    } finally {
      if (prev !== undefined) process.env.SSH_TARGET_ALLOW_LOOPBACK = prev;
    }
    assert(threw, 'expected TARGET_NOT_ALLOWED for loopback');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('e2e-ssh-engine: fatal', err);
  process.exit(1);
});
