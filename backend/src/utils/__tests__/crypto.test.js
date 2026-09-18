/**
 * crypto.js — envelope encryption round-trips, legacy-format compatibility,
 * key rotation (SERVER_ENCRYPTION_KEY_PREVIOUS), and tamper detection.
 *
 * config is a plain singleton object (not frozen), so tests mutate
 * config.encryption directly to simulate key rotation without needing
 * ESM module mocking (which is unreliable in this Jest setup — see
 * caService.test.js for prior art).
 */

import crypto from 'crypto';
import config from '../../config/index.js';
import { encrypt, decrypt, isCurrentEnvelope } from '../crypto.js';

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

const originalKey = config.encryption.key;
const originalPrevious = config.encryption.previousKeys;

afterEach(() => {
  config.encryption.key = originalKey;
  config.encryption.previousKeys = originalPrevious;
});

describe('encrypt / decrypt — v2 envelope round trip', () => {
  test('round-trips plaintext', () => {
    config.encryption.key = KEY_A;
    const ciphertext = encrypt('hunter2');
    expect(ciphertext.startsWith('v2:')).toBe(true);
    expect(decrypt(ciphertext)).toBe('hunter2');
  });

  test('envelope carries a keyId distinct from the plaintext/ciphertext', () => {
    config.encryption.key = KEY_A;
    const ciphertext = encrypt('secret-value');
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  test('isCurrentEnvelope reflects whether the active key produced the envelope', () => {
    config.encryption.key = KEY_A;
    const ciphertext = encrypt('value');
    expect(isCurrentEnvelope(ciphertext)).toBe(true);

    config.encryption.key = KEY_B;
    expect(isCurrentEnvelope(ciphertext)).toBe(false);
  });
});

describe('decrypt — legacy (unversioned) envelope compatibility', () => {
  function legacyEncrypt(plaintext, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  test('reads pre-existing rows encrypted with the old unversioned format', () => {
    config.encryption.key = KEY_A;
    const legacyBlob = legacyEncrypt('legacy-plaintext', KEY_A);
    expect(legacyBlob.startsWith('v2:')).toBe(false);
    expect(decrypt(legacyBlob)).toBe('legacy-plaintext');
  });
});

describe('key rotation — SERVER_ENCRYPTION_KEY_PREVIOUS', () => {
  test('decrypts v2 envelopes written under a previous key once rotated', () => {
    config.encryption.key = KEY_A;
    config.encryption.previousKeys = [];
    const oldCiphertext = encrypt('rotate-me');

    // Simulate rotation: KEY_B becomes current, KEY_A moves to previous.
    config.encryption.key = KEY_B;
    config.encryption.previousKeys = [KEY_A];

    expect(decrypt(oldCiphertext)).toBe('rotate-me');
    // New encryptions use the new current key.
    const newCiphertext = encrypt('rotate-me');
    expect(isCurrentEnvelope(newCiphertext)).toBe(true);
    expect(isCurrentEnvelope(oldCiphertext)).toBe(false);
  });

  test('decrypts legacy envelopes written under a previous key once rotated', () => {
    config.encryption.key = KEY_A;
    const legacyBlob = (() => {
      const key = Buffer.from(KEY_A, 'hex');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update('old-legacy', 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, authTag, encrypted]).toString('base64');
    })();

    config.encryption.key = KEY_B;
    config.encryption.previousKeys = [KEY_A];
    expect(decrypt(legacyBlob)).toBe('old-legacy');
  });

  test('throws when no known key (current or previous) matches the envelope keyId', () => {
    config.encryption.key = KEY_A;
    const ciphertext = encrypt('unreachable-after-hard-rotation');

    // Hard rotation: old key dropped entirely, not kept as "previous".
    config.encryption.key = KEY_B;
    config.encryption.previousKeys = [];

    expect(() => decrypt(ciphertext)).toThrow();
  });
});

describe('tamper detection', () => {
  test('rejects a v2 envelope with a flipped ciphertext byte', () => {
    config.encryption.key = KEY_A;
    const ciphertext = encrypt('do-not-tamper');
    const [version, keyId, blobB64] = ciphertext.split(':');
    const blob = Buffer.from(blobB64, 'base64');
    // Flip a byte inside the ciphertext region (after iv(12) + tag(16)).
    blob[30] ^= 0xff;
    const tampered = `${version}:${keyId}:${blob.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  test('rejects an envelope with a tampered auth tag', () => {
    config.encryption.key = KEY_A;
    const ciphertext = encrypt('do-not-tamper-2');
    const [version, keyId, blobB64] = ciphertext.split(':');
    const blob = Buffer.from(blobB64, 'base64');
    blob[15] ^= 0xff; // inside the 16-byte auth tag region
    const tampered = `${version}:${keyId}:${blob.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });
});
