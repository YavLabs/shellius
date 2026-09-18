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
 * See the final report for the exact commands used to build this fixture.
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
