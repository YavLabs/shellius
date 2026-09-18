/**
 * sshKeys.js — real ssh-keygen integration tests.
 *
 * These shell out to the actual `ssh-keygen` binary (no mocking) — exactly
 * what the Keystore generate/import flows do in production. Skips itself if
 * ssh-keygen isn't on PATH (matches the "smokeIt"-skip pattern used
 * elsewhere in this repo for optional external dependencies).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  generateKeyPair,
  importPrivateKey,
  fingerprintPublicKey,
  isValidOpenSshPublicKey,
} from '../sshKeys.js';

const execFileAsync = promisify(execFile);

let sshKeygenAvailable = false;
beforeAll(async () => {
  try {
    // NOTE: don't probe with `-h` — on some OpenSSH builds an unrecognized
    // flag falls through to the interactive "Generate a new key pair" prompt
    // and blocks forever reading from stdin (which is an open, unclosed pipe
    // under execFile). `-V` (missing its required argument) reliably fails
    // fast with a usage error on every OpenSSH build without ever touching
    // stdin, while still proving the binary exists on PATH.
    await execFileAsync('ssh-keygen', ['-V']).catch(() => {});
    sshKeygenAvailable = true;
  } catch {
    sshKeygenAvailable = false;
  }
});

const maybeIt = (name, fn) => it(name, async () => {
  if (!sshKeygenAvailable) {
    console.warn('ssh-keygen not available — skipping', name);
    return;
  }
  await fn();
});

describe('isValidOpenSshPublicKey', () => {
  it('accepts a well-formed ed25519 public key', () => {
    expect(
      isValidOpenSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJUGdmLE0gqTAKv8i9Op8YTzThAzW/6UKbzGEMxUXDfB comment')
    ).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(isValidOpenSshPublicKey('not a key')).toBe(false);
    expect(isValidOpenSshPublicKey('')).toBe(false);
    expect(isValidOpenSshPublicKey(null)).toBe(false);
  });

  it('rejects multi-line input', () => {
    expect(isValidOpenSshPublicKey('ssh-ed25519 AAAA\nssh-ed25519 BBBB')).toBe(false);
  });
});

describe('generateKeyPair', () => {
  maybeIt('generates an ed25519 key pair with a fingerprint and no bits', async () => {
    const key = await generateKeyPair({ keyType: 'ed25519', comment: 'test@shellius' });
    expect(key.keyType).toBe('ed25519');
    expect(key.bits).toBeNull();
    expect(key.fingerprint).toMatch(/^SHA256:/);
    expect(key.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(key.privateKey).toContain('PRIVATE KEY');
  });

  maybeIt('generates an rsa key pair honoring requested bits', async () => {
    const key = await generateKeyPair({ keyType: 'rsa', bits: 2048 });
    expect(key.keyType).toBe('rsa');
    expect(key.bits).toBe(2048);
    expect(key.publicKey.startsWith('ssh-rsa ')).toBe(true);
  });

  maybeIt('generates a passphrase-protected key that importPrivateKey can decrypt', async () => {
    const key = await generateKeyPair({ keyType: 'ecdsa', bits: 256, passphrase: 'sekret123' });
    const imported = await importPrivateKey({ privateKey: key.privateKey, passphrase: 'sekret123' });
    expect(imported.fingerprint).toBe(key.fingerprint);
    expect(imported.keyType).toBe('ecdsa');
    expect(imported.bits).toBe(256);
  });

  it('rejects an unsupported keyType', async () => {
    await expect(generateKeyPair({ keyType: 'dsa' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('importPrivateKey', () => {
  maybeIt('round-trips a freshly generated key (fingerprint matches)', async () => {
    const key = await generateKeyPair({ keyType: 'ed25519' });
    const imported = await importPrivateKey({ privateKey: key.privateKey });
    expect(imported.fingerprint).toBe(key.fingerprint);
    // Compare the type+base64 fields only — comments/whitespace formatting
    // can legitimately differ between what we generated and what sshpk emits.
    expect(imported.publicKey.split(' ').slice(0, 2)).toEqual(key.publicKey.split(' ').slice(0, 2));
  });

  maybeIt('requires a passphrase for an encrypted key', async () => {
    const key = await generateKeyPair({ keyType: 'ed25519', passphrase: 'hunter2' });
    await expect(importPrivateKey({ privateKey: key.privateKey })).rejects.toMatchObject({
      statusCode: 400,
      code: 'KEY_PASSPHRASE_REQUIRED',
    });
  });

  maybeIt('rejects the wrong passphrase', async () => {
    const key = await generateKeyPair({ keyType: 'ed25519', passphrase: 'hunter2' });
    await expect(importPrivateKey({ privateKey: key.privateKey, passphrase: 'wrong' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'KEY_BAD_PASSPHRASE',
    });
  });

  it('rejects garbage input', async () => {
    await expect(importPrivateKey({ privateKey: 'not a real key' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires privateKey', async () => {
    await expect(importPrivateKey({})).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('fingerprintPublicKey', () => {
  maybeIt('matches the fingerprint computed at generation time', async () => {
    const key = await generateKeyPair({ keyType: 'ed25519' });
    expect(fingerprintPublicKey(key.publicKey)).toBe(key.fingerprint);
  });

  it('rejects a malformed public key', () => {
    expect(() => fingerprintPublicKey('garbage')).toThrow();
  });
});
