/**
 * sshKeys.js tests
 *
 * Generates real key-material fixtures at test time via `ssh-keygen`/`openssl`
 * (OpenSSH, PKCS#1, SEC1, PKCS#8, DSA) in a private temp dir, and reads
 * committed PuTTY .ppk v2/v3 fixtures (generated once via `puttygen` — see
 * fixtures/README below) from src/utils/__tests__/fixtures/. Every normalised
 * key is cross-checked against `ssh-keygen -lf` of the *original* public key,
 * so a fingerprint match proves the private key material round-tripped
 * correctly — not just that parsing didn't throw.
 *
 * PPK fixture passphrase (test-only, not a real secret): "shellius-ppk-test"
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  normalizePrivateKey,
  importPrivateKey,
  parseCertificate,
  publicKeyMatches,
  detectFormat,
  fingerprintPublicKey,
} from '../sshKeys.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// The PPK fixtures were generated once via:
//   docker run --rm -v <dir>:/w alpine sh -c \
//     'apk add --no-cache putty openssh-keygen && puttygen ... -O private --ppk-param version=2|3'
// from an ed25519/rsa OpenSSH key with comment "test", encrypted ones with
// passphrase "pw1234" (test-only fixture, not a real secret).
const PPK_PASSPHRASE = 'pw1234';

let tmpDir;

async function sshKeygenFingerprint(pubPath) {
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', pubPath]);
  return stdout.trim().split(' ')[1];
}

async function genKeyPair(name, args, passphrase = '') {
  const keyPath = path.join(tmpDir, name);
  await execFileAsync('ssh-keygen', ['-f', keyPath, '-N', passphrase, '-q', ...args]);
  const privateKey = await fs.readFile(keyPath, 'utf8');
  const fingerprint = await sshKeygenFingerprint(`${keyPath}.pub`);
  return { keyPath, privateKey, fingerprint };
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-sshkeys-test-'));
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('detectFormat', () => {
  test('recognises OpenSSH', () => {
    expect(detectFormat('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n').format).toBe(
      'openssh'
    );
  });
  test('recognises PPK v2/v3 by header, case-insensitively', () => {
    expect(detectFormat('PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\n').format).toBe('ppk2');
    expect(detectFormat('PuTTY-User-Key-File-3: ssh-rsa\nEncryption: aes256-cbc\n').format).toEqual('ppk3');
  });
  test('returns null format for garbage', () => {
    expect(detectFormat('not a key at all').format).toBeNull();
  });
});

describe('normalizePrivateKey — OpenSSH', () => {
  test('ed25519 plain round-trips to the same fingerprint', async () => {
    const { privateKey, fingerprint } = await genKeyPair('ed25519-plain', ['-t', 'ed25519', '-C', 'test']);
    const result = await normalizePrivateKey({ privateKey });
    expect(result.format).toBe('openssh');
    expect(result.keyType).toBe('ed25519');
    expect(result.encrypted).toBe(false);
    expect(result.fingerprint).toBe(fingerprint);
  });

  test('ed25519 bcrypt-encrypted requires and validates passphrase', async () => {
    const { privateKey, fingerprint } = await genKeyPair('ed25519-enc', ['-t', 'ed25519'], 'correct-horse');

    await expect(normalizePrivateKey({ privateKey })).rejects.toMatchObject({ code: 'KEY_PASSPHRASE_REQUIRED' });
    await expect(normalizePrivateKey({ privateKey, passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_INVALID',
    });

    const result = await normalizePrivateKey({ privateKey, passphrase: 'correct-horse' });
    expect(result.encrypted).toBe(true);
    expect(result.fingerprint).toBe(fingerprint);
    // Re-encrypted with the SAME passphrase — normalized output must still
    // require it, and still decrypt to the identical key.
    const roundTrip = await normalizePrivateKey({ privateKey: result.privateKey, passphrase: 'correct-horse' });
    expect(roundTrip.fingerprint).toBe(fingerprint);
    await expect(normalizePrivateKey({ privateKey: result.privateKey })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_REQUIRED',
    });
  });

  test('rsa 2048 plain', async () => {
    const { privateKey, fingerprint } = await genKeyPair('rsa-plain', ['-t', 'rsa', '-b', '2048']);
    const result = await normalizePrivateKey({ privateKey });
    expect(result.keyType).toBe('rsa');
    expect(result.bits).toBe(2048);
    expect(result.fingerprint).toBe(fingerprint);
  });

  test('ecdsa nistp256 plain', async () => {
    const { privateKey, fingerprint } = await genKeyPair('ecdsa-plain', ['-t', 'ecdsa', '-b', '256']);
    const result = await normalizePrivateKey({ privateKey });
    expect(result.keyType).toBe('ecdsa');
    expect(result.bits).toBe(256);
    expect(result.fingerprint).toBe(fingerprint);
  });

  test('a pasted key with lost newlines is recovered', async () => {
    const { privateKey, fingerprint } = await genKeyPair('ed25519-pasted', ['-t', 'ed25519']);
    const squashed = privateKey.replace(/\n/g, '').replace('-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----\n').replace('-----END OPENSSH PRIVATE KEY-----', '\n-----END OPENSSH PRIVATE KEY-----\n');
    const result = await normalizePrivateKey({ privateKey: squashed });
    expect(result.fingerprint).toBe(fingerprint);
  });
});

describe('normalizePrivateKey — PEM (PKCS#1 / SEC1 / PKCS#8)', () => {
  async function openssl(args) {
    await execFileAsync('openssl', args);
  }

  test('PKCS#1 RSA, plain and legacy-encrypted (Proc-Type/DEK-Info)', async () => {
    const plainPath = path.join(tmpDir, 'pkcs1-plain.pem');
    const encPath = path.join(tmpDir, 'pkcs1-enc.pem');
    await openssl(['genrsa', '-traditional', '-out', plainPath, '2048']);
    await openssl(['rsa', '-in', plainPath, '-aes256', '-traditional', '-passout', 'pass:s3cr3t', '-out', encPath]);

    const pubPath = path.join(tmpDir, 'pkcs1-plain.pub');
    await execFileAsync('ssh-keygen', ['-y', '-f', plainPath], { encoding: 'utf8' }).then(async ({ stdout }) => {
      await fs.writeFile(pubPath, stdout);
    });
    const fingerprint = await sshKeygenFingerprint(pubPath);

    const plainText = await fs.readFile(plainPath, 'utf8');
    const encText = await fs.readFile(encPath, 'utf8');

    expect(detectFormat(plainText)).toMatchObject({ format: 'pkcs1', encrypted: false });
    expect(detectFormat(encText)).toMatchObject({ format: 'pkcs1', encrypted: true });

    const plainResult = await normalizePrivateKey({ privateKey: plainText });
    expect(plainResult.fingerprint).toBe(fingerprint);

    await expect(normalizePrivateKey({ privateKey: encText })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_REQUIRED',
    });
    await expect(normalizePrivateKey({ privateKey: encText, passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_INVALID',
    });
    const encResult = await normalizePrivateKey({ privateKey: encText, passphrase: 's3cr3t' });
    expect(encResult.fingerprint).toBe(fingerprint);
  });

  test('SEC1 EC, plain and encrypted', async () => {
    const plainPath = path.join(tmpDir, 'sec1-plain.pem');
    const encPath = path.join(tmpDir, 'sec1-enc.pem');
    await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', plainPath]);
    await openssl(['ec', '-in', plainPath, '-aes256', '-passout', 'pass:s3cr3t', '-out', encPath]);

    const pubPath = path.join(tmpDir, 'sec1-plain.pub');
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', plainPath]);
    await fs.writeFile(pubPath, stdout);
    const fingerprint = await sshKeygenFingerprint(pubPath);

    const plainText = await fs.readFile(plainPath, 'utf8');
    const encText = await fs.readFile(encPath, 'utf8');
    expect(detectFormat(plainText).format).toBe('sec1');

    expect((await normalizePrivateKey({ privateKey: plainText })).fingerprint).toBe(fingerprint);
    await expect(normalizePrivateKey({ privateKey: encText, passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_INVALID',
    });
    expect((await normalizePrivateKey({ privateKey: encText, passphrase: 's3cr3t' })).fingerprint).toBe(fingerprint);
  });

  test('PKCS#8, plain and encrypted (rsa + ed25519)', async () => {
    const rsaPkcs1 = path.join(tmpDir, 'p8src-rsa.pem');
    const rsaPlain = path.join(tmpDir, 'pkcs8-rsa-plain.pem');
    const rsaEnc = path.join(tmpDir, 'pkcs8-rsa-enc.pem');
    await openssl(['genrsa', '-out', rsaPkcs1, '2048']);
    await openssl(['pkcs8', '-topk8', '-nocrypt', '-in', rsaPkcs1, '-out', rsaPlain]);
    await openssl(['pkcs8', '-topk8', '-passout', 'pass:s3cr3t', '-in', rsaPkcs1, '-out', rsaEnc]);

    const pubPath = path.join(tmpDir, 'pkcs8-rsa-plain.pub');
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', rsaPlain]);
    await fs.writeFile(pubPath, stdout);
    const fingerprint = await sshKeygenFingerprint(pubPath);

    const plainResult = await normalizePrivateKey({ privateKey: await fs.readFile(rsaPlain, 'utf8') });
    expect(plainResult.format).toBe('pkcs8');
    expect(plainResult.fingerprint).toBe(fingerprint);

    const encText = await fs.readFile(rsaEnc, 'utf8');
    await expect(normalizePrivateKey({ privateKey: encText, passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_INVALID',
    });
    expect((await normalizePrivateKey({ privateKey: encText, passphrase: 's3cr3t' })).fingerprint).toBe(fingerprint);

    // ed25519 via PKCS#8 (genpkey)
    const edPath = path.join(tmpDir, 'pkcs8-ed25519.pem');
    await openssl(['genpkey', '-algorithm', 'ed25519', '-out', edPath]);
    const edPub = path.join(tmpDir, 'pkcs8-ed25519.pub');
    const edOut = await execFileAsync('ssh-keygen', ['-y', '-f', edPath]);
    await fs.writeFile(edPub, edOut.stdout);
    const edFingerprint = await sshKeygenFingerprint(edPub);
    const edResult = await normalizePrivateKey({ privateKey: await fs.readFile(edPath, 'utf8') });
    expect(edResult.keyType).toBe('ed25519');
    expect(edResult.fingerprint).toBe(edFingerprint);
  });

  test('DSA is rejected as unsupported', async () => {
    const paramPath = path.join(tmpDir, 'dsaparam.pem');
    const dsaPath = path.join(tmpDir, 'dsa.pem');
    await openssl(['dsaparam', '-out', paramPath, '1024']);
    await openssl(['gendsa', '-out', dsaPath, paramPath]);
    const dsaText = await fs.readFile(dsaPath, 'utf8');
    await expect(normalizePrivateKey({ privateKey: dsaText })).rejects.toMatchObject({
      code: 'KEY_UNSUPPORTED_TYPE',
    });
  });

  test('unrecognized content is rejected', async () => {
    await expect(normalizePrivateKey({ privateKey: 'this is not a key' })).rejects.toMatchObject({
      code: 'KEY_UNSUPPORTED_FORMAT',
    });
  });
});

describe('normalizePrivateKey — PuTTY .ppk v2/v3', () => {
  async function readFixture(name) {
    return fs.readFile(path.join(FIXTURES_DIR, name), 'utf8');
  }

  test('v2 plain (ed25519 + rsa)', async () => {
    const ed = await normalizePrivateKey({ privateKey: await readFixture('ed25519-v2-plain.ppk') });
    expect(ed.format).toBe('ppk2');
    expect(ed.keyType).toBe('ed25519');
    expect(ed.encrypted).toBe(false);

    const rsa = await normalizePrivateKey({ privateKey: await readFixture('rsa-v2-plain.ppk') });
    expect(rsa.format).toBe('ppk2');
    expect(rsa.keyType).toBe('rsa');
    expect(rsa.bits).toBe(2048);
  });

  test('v2 encrypted: correct/missing/wrong passphrase', async () => {
    const text = await readFixture('ed25519-v2-encrypted.ppk');
    await expect(normalizePrivateKey({ privateKey: text })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_REQUIRED',
    });
    await expect(normalizePrivateKey({ privateKey: text, passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_INVALID',
    });
    const result = await normalizePrivateKey({ privateKey: text, passphrase: PPK_PASSPHRASE });
    expect(result.encrypted).toBe(true);
    expect(result.keyType).toBe('ed25519');

    const plain = await normalizePrivateKey({ privateKey: await readFixture('ed25519-v2-plain.ppk') });
    expect(result.fingerprint).toBe(plain.fingerprint);
  });

  test('v3 plain (ed25519)', async () => {
    const result = await normalizePrivateKey({ privateKey: await readFixture('ed25519-v3-plain.ppk') });
    expect(result.format).toBe('ppk3');
    expect(result.keyType).toBe('ed25519');
    expect(result.encrypted).toBe(false);
  });

  test('v3 encrypted (Argon2): correct/missing/wrong passphrase, MAC-verified', async () => {
    const text = await readFixture('ed25519-v3-encrypted.ppk');
    await expect(normalizePrivateKey({ privateKey: text })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_REQUIRED',
    });
    await expect(normalizePrivateKey({ privateKey: text, passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'KEY_PASSPHRASE_INVALID',
    });
    const result = await normalizePrivateKey({ privateKey: text, passphrase: PPK_PASSPHRASE });
    expect(result.encrypted).toBe(true);

    const plain = await normalizePrivateKey({ privateKey: await readFixture('ed25519-v3-plain.ppk') });
    expect(result.fingerprint).toBe(plain.fingerprint);
  });

  test('v3 encrypted rsa: correct passphrase matches the plain v2 rsa fingerprint', async () => {
    const encrypted = await normalizePrivateKey({
      privateKey: await readFixture('rsa-v3-encrypted.ppk'),
      passphrase: PPK_PASSPHRASE,
    });
    const plain = await normalizePrivateKey({ privateKey: await readFixture('rsa-v2-plain.ppk') });
    expect(encrypted.fingerprint).toBe(plain.fingerprint);
  });
});

describe('importPrivateKey (legacy shape)', () => {
  test('returns the metadata-only shape', async () => {
    const { privateKey, fingerprint } = await genKeyPair('legacy-ed25519', ['-t', 'ed25519']);
    const result = await importPrivateKey({ privateKey });
    expect(Object.keys(result).sort()).toEqual(['bits', 'comment', 'fingerprint', 'keyType', 'publicKey'].sort());
    expect(result.fingerprint).toBe(fingerprint);
  });
});

describe('certificates', () => {
  let caPath;
  let userKeyPath;
  let userPubText;
  let certText;
  let userFingerprint;

  beforeAll(async () => {
    const ca = await genKeyPair('ca', ['-t', 'ed25519']);
    caPath = ca.keyPath;
    const user = await genKeyPair('cert-user', ['-t', 'ed25519']);
    userKeyPath = user.keyPath;
    userFingerprint = user.fingerprint;
    userPubText = await fs.readFile(`${userKeyPath}.pub`, 'utf8');

    await execFileAsync('ssh-keygen', [
      '-s', caPath,
      '-I', 'test-key-id',
      '-n', 'alice,bob',
      '-V', '-1w:+52w',
      `${userKeyPath}.pub`,
    ]);
    certText = await fs.readFile(`${userKeyPath}-cert.pub`, 'utf8');
  });

  test('parseCertificate returns principals/keyId/validity/fingerprints', () => {
    const parsed = parseCertificate(certText);
    expect(parsed.type).toBe('user');
    expect(parsed.keyId).toBe('test-key-id');
    expect(parsed.principals).toEqual(['alice', 'bob']);
    expect(parsed.expired).toBe(false);
    expect(parsed.publicKeyFingerprint).toBe(userFingerprint);
    expect(parsed.caFingerprint).toEqual(expect.stringContaining('SHA256:'));
    expect(parsed.validAfter).toBeInstanceOf(Date);
    expect(parsed.validBefore).toBeInstanceOf(Date);
  });

  test('rejects garbage certificate text', () => {
    expect(() => parseCertificate('not a cert')).toThrow(
      expect.objectContaining({ code: 'CERT_INVALID' })
    );
  });

  test('publicKeyMatches: true for the certified key, false for another key', async () => {
    expect(publicKeyMatches({ publicKey: userPubText }, userPubText)).toBe(true);

    const other = await genKeyPair('cert-other', ['-t', 'ed25519']);
    const otherPubText = await fs.readFile(`${other.keyPath}.pub`, 'utf8');
    expect(publicKeyMatches({ publicKey: userPubText }, otherPubText)).toBe(false);

    // Cert-vs-key mismatch check, as keystoreService uses it:
    const parsed = parseCertificate(certText);
    expect(parsed.publicKeyFingerprint).toBe(fingerprintPublicKey(userPubText));
    expect(parsed.publicKeyFingerprint).not.toBe(fingerprintPublicKey(otherPubText));
  });
});
