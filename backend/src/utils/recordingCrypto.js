/**
 * Encryption at rest for session recordings (asciinema casts).
 *
 * Recordings contain everything printed in a terminal, so they are encrypted
 * before they reach object storage, independent of bucket-level SSE:
 *
 *   'SHREC1' (6 bytes magic)
 *   uint16BE  length of the wrapped data key
 *   wrapped data key  — utils/crypto encrypt() of the hex DEK (versioned
 *                       envelope, so SERVER_ENCRYPTION_KEY rotation applies)
 *   12-byte IV
 *   AES-256-GCM ciphertext …
 *   16-byte GCM auth tag (trailer)
 *
 * A fresh 256-bit data key per recording. Old plaintext casts (no magic) are
 * still readable: createDecryptStream() passes them through unchanged.
 */

import crypto from 'crypto';
import { Transform } from 'stream';
import { encrypt, decrypt } from './crypto.js';

const MAGIC = Buffer.from('SHREC1');
const IV_LEN = 12;
const TAG_LEN = 16;

/** Transform that encrypts everything written to it into the SHREC1 format. */
export function createEncryptStream() {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(IV_LEN);
  const wrapped = Buffer.from(encrypt(dek.toString('hex')), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  dek.fill(0);

  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(wrapped.length);
  let headerSent = false;

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (!headerSent) {
          this.push(Buffer.concat([MAGIC, lenBuf, wrapped, iv]));
          headerSent = true;
        }
        const out = cipher.update(chunk);
        if (out.length) this.push(out);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (!headerSent) this.push(Buffer.concat([MAGIC, lenBuf, wrapped, iv]));
        const fin = cipher.final();
        if (fin.length) this.push(fin);
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

/**
 * Transform that decrypts a SHREC1 stream, or passes a legacy plaintext cast
 * through untouched. The final 16 bytes are held back as the GCM tag; a
 * tampered or truncated recording fails with an error at the end.
 */
export function createDecryptStream() {
  let mode = null; // null (sniffing) | 'plain' | 'enc'
  let head = Buffer.alloc(0);
  let decipher = null;
  let tail = Buffer.alloc(0); // last TAG_LEN bytes seen (candidate tag)

  function feedCipher(stream, data) {
    const buf = Buffer.concat([tail, data]);
    if (buf.length <= TAG_LEN) {
      tail = buf;
      return;
    }
    tail = buf.subarray(buf.length - TAG_LEN);
    const out = decipher.update(buf.subarray(0, buf.length - TAG_LEN));
    if (out.length) stream.push(out);
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (mode === 'plain') {
          this.push(chunk);
          return cb();
        }
        if (mode === 'enc') {
          feedCipher(this, chunk);
          return cb();
        }
        head = Buffer.concat([head, chunk]);
        if (head.length < MAGIC.length) return cb();
        if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
          mode = 'plain';
          this.push(head);
          head = null;
          return cb();
        }
        if (head.length < MAGIC.length + 2) return cb();
        const wrappedLen = head.readUInt16BE(MAGIC.length);
        const hdrLen = MAGIC.length + 2 + wrappedLen + IV_LEN;
        if (head.length < hdrLen) return cb();
        const wrapped = head.subarray(MAGIC.length + 2, MAGIC.length + 2 + wrappedLen).toString('utf8');
        const iv = head.subarray(MAGIC.length + 2 + wrappedLen, hdrLen);
        const dek = Buffer.from(decrypt(wrapped), 'hex');
        decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
        dek.fill(0);
        mode = 'enc';
        const rest = head.subarray(hdrLen);
        head = null;
        if (rest.length) feedCipher(this, rest);
        return cb();
      } catch (err) {
        return cb(err);
      }
    },
    flush(cb) {
      try {
        if (mode === 'enc') {
          if (tail.length !== TAG_LEN) throw new Error('Recording is truncated');
          decipher.setAuthTag(tail);
          const fin = decipher.final();
          if (fin.length) this.push(fin);
        } else if (mode === null && head && head.length) {
          this.push(head); // shorter than the magic → legacy plaintext
        }
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}
