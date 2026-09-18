/**
 * keystoreService — DTO secret-stripping tests.
 *
 * Pure function tests (no DB / network): feed toSshKeyDTO/toCredentialDTO a
 * row shaped like what Prisma would return (including secret columns) and
 * assert the DTO never carries them, per the Keystore contract
 * (docs/keystore-and-quick-connect.md): list/get endpoints must only expose
 * hasPassphrase/hasPassword, never key/password material.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  toSshKeyDTO,
  toCredentialDTO,
  toKeyDeploymentDTO,
  resolveCredentialAuth,
  validateAuthMaterial,
} from '../keystoreService.js';

const execFileAsync = promisify(execFile);

describe('toSshKeyDTO', () => {
  const rawKey = {
    id: 'key-1',
    name: 'deploy key',
    description: 'a key',
    keyType: 'ed25519',
    bits: null,
    publicKey: 'ssh-ed25519 AAAA... comment',
    privateKeyEncrypted: 'super-secret-base64-blob',
    passphraseEncrypted: 'another-secret-blob',
    fingerprint: 'SHA256:abc123',
    comment: 'comment',
    source: 'generated',
    createdById: 'user-1',
    lastExportedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
  };

  it('never includes privateKeyEncrypted or passphraseEncrypted', () => {
    const dto = toSshKeyDTO(rawKey);
    expect(dto).not.toHaveProperty('privateKeyEncrypted');
    expect(dto).not.toHaveProperty('passphraseEncrypted');
    expect(JSON.stringify(dto)).not.toContain('super-secret-base64-blob');
    expect(JSON.stringify(dto)).not.toContain('another-secret-blob');
  });

  it('derives hasPassphrase from presence of passphraseEncrypted', () => {
    expect(toSshKeyDTO(rawKey).hasPassphrase).toBe(true);
    expect(toSshKeyDTO({ ...rawKey, passphraseEncrypted: null }).hasPassphrase).toBe(false);
  });

  it('exposes publicKey and fingerprint (not secret)', () => {
    const dto = toSshKeyDTO(rawKey);
    expect(dto.publicKey).toBe(rawKey.publicKey);
    expect(dto.fingerprint).toBe(rawKey.fingerprint);
  });

  it('defaults createdBy/credentialCount/deploymentCount when omitted', () => {
    const dto = toSshKeyDTO(rawKey);
    expect(dto.createdBy).toBeNull();
    expect(dto.credentialCount).toBe(0);
    expect(dto.deploymentCount).toBe(0);
  });

  it('passes through provided createdBy/counts', () => {
    const dto = toSshKeyDTO(rawKey, {
      createdBy: { id: 'user-1', name: 'Alice' },
      credentialCount: 3,
      deploymentCount: 5,
    });
    expect(dto.createdBy).toEqual({ id: 'user-1', name: 'Alice' });
    expect(dto.credentialCount).toBe(3);
    expect(dto.deploymentCount).toBe(5);
  });

  it('defaults originalFormat/certificate to null when absent', () => {
    const dto = toSshKeyDTO(rawKey);
    expect(dto.originalFormat).toBeNull();
    expect(dto.certificate).toBeNull();
  });

  it('surfaces originalFormat and a parsed certificate summary (never the raw cert text)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-cert-dto-'));
    try {
      const caPath = path.join(tmpDir, 'ca');
      const userPath = path.join(tmpDir, 'user');
      await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', caPath, '-q']);
      await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', userPath, '-q']);
      await execFileAsync('ssh-keygen', [
        '-s', caPath, '-I', 'dto-test', '-n', 'alice', '-V', '-1w:+52w', `${userPath}.pub`,
      ]);
      const certificate = await fs.readFile(`${userPath}-cert.pub`, 'utf8');

      const dto = toSshKeyDTO({ ...rawKey, originalFormat: 'pkcs8', certificate });
      expect(dto.originalFormat).toBe('pkcs8');
      expect(dto.certificate).toMatchObject({ type: 'user', keyId: 'dto-test', principals: ['alice'] });
      expect(JSON.stringify(dto)).not.toContain('ssh-ed25519-cert-v01@openssh.com'); // raw cert text absent
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('toCredentialDTO', () => {
  const rawCred = {
    id: 'cred-1',
    name: 'prod-db admin',
    description: null,
    username: 'admin',
    authType: 'key_password',
    passwordEncrypted: 'super-secret-password-blob',
    tags: ['db'],
    lastUsedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
  };

  it('never includes passwordEncrypted', () => {
    const dto = toCredentialDTO(rawCred);
    expect(dto).not.toHaveProperty('passwordEncrypted');
    expect(JSON.stringify(dto)).not.toContain('super-secret-password-blob');
  });

  it('derives hasPassword from presence of passwordEncrypted', () => {
    expect(toCredentialDTO(rawCred).hasPassword).toBe(true);
    expect(toCredentialDTO({ ...rawCred, passwordEncrypted: null }).hasPassword).toBe(false);
  });

  it('never includes a raw sshKey private key even when sshKey is attached', () => {
    const sshKeyDto = { id: 'key-1', name: 'k', fingerprint: 'SHA256:xyz', keyType: 'ed25519' };
    const dto = toCredentialDTO(rawCred, { sshKey: sshKeyDto, serverCount: 2 });
    expect(dto.sshKey).toEqual(sshKeyDto);
    expect(JSON.stringify(dto)).not.toMatch(/privateKey/i);
    expect(dto.serverCount).toBe(2);
  });

  it('defaults sshKey to null and serverCount to 0 when omitted', () => {
    const dto = toCredentialDTO(rawCred);
    expect(dto.sshKey).toBeNull();
    expect(dto.serverCount).toBe(0);
  });
});

describe('toKeyDeploymentDTO', () => {
  it('resolves deployedBy from the provided map, or null when unset/unknown', () => {
    const base = {
      id: 'dep-1',
      batchId: 'batch-1',
      action: 'deploy',
      status: 'success',
      targetUser: 'root',
      authMode: 'server',
      error: null,
      output: 'ok',
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
      server: { id: 's1', hostname: 'h', displayName: null, environment: 'dev' },
      sshKey: { id: 'k1', name: 'key', fingerprint: 'SHA256:abc' },
      deployedById: 'user-1',
    };
    const map = new Map([['user-1', { id: 'user-1', name: 'Alice' }]]);
    expect(toKeyDeploymentDTO(base, map).deployedBy).toEqual({ id: 'user-1', name: 'Alice' });
    expect(toKeyDeploymentDTO({ ...base, deployedById: null }).deployedBy).toBeNull();
    expect(toKeyDeploymentDTO({ ...base, deployedById: 'unknown-user' }, map).deployedBy).toBeNull();
  });
});

describe('resolveCredentialAuth', () => {
  it('includes the key certificate when present, for authType "key"', async () => {
    const { encrypt } = await import('../../utils/crypto.js');
    const cred = {
      username: 'deploy',
      authType: 'key',
      passwordEncrypted: null,
      sshKey: {
        privateKeyEncrypted: encrypt('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n'),
        passphraseEncrypted: null,
        certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA... user@host',
      },
    };
    const opts = resolveCredentialAuth(cred);
    expect(opts.certificate).toBe(cred.sshKey.certificate);
    expect(opts.privateKey).toContain('OPENSSH PRIVATE KEY');
  });

  it('omits certificate when the key has none', async () => {
    const { encrypt } = await import('../../utils/crypto.js');
    const cred = {
      username: 'deploy',
      authType: 'key',
      passwordEncrypted: null,
      sshKey: {
        privateKeyEncrypted: encrypt('fake-key-text'),
        passphraseEncrypted: null,
        certificate: null,
      },
    };
    expect(resolveCredentialAuth(cred).certificate).toBeUndefined();
  });
});

describe('validateAuthMaterial — sshKeyId: null unlink (key_password -> password)', () => {
  it('rejects clearing the key while authType still requires one', () => {
    expect(() =>
      validateAuthMaterial({ authType: 'key_password', password: 'x', sshKeyId: null, newKey: undefined })
    ).toThrow(/requires both a key/);

    expect(() =>
      validateAuthMaterial({ authType: 'key', password: null, sshKeyId: null, newKey: undefined })
    ).toThrow(/sshKeyId or newKey is required/);
  });

  it('allows sshKeyId: null when switching authType to password (with a stored password)', () => {
    expect(() =>
      validateAuthMaterial({ authType: 'password', password: 'x', sshKeyId: null, newKey: undefined })
    ).not.toThrow();
  });

  it('still requires a stored password for authType "password"', () => {
    expect(() =>
      validateAuthMaterial({ authType: 'password', password: null, sshKeyId: null, newKey: undefined })
    ).toThrow(/password is required/);
  });
});
