import { Readable } from 'stream';
import { createEncryptStream, createDecryptStream } from '../recordingCrypto.js';

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// Feed data in awkward chunk sizes to exercise header/tag boundary handling.
function chunked(buf, size) {
  const parts = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

const cast =
  '{"version":2,"width":80,"height":24}\n' +
  Array.from({ length: 500 }, (_, i) => JSON.stringify([i / 10, 'o', `line ${i} secret=hunter2\r\n`])).join('\n');

describe('recordingCrypto', () => {
  test('round-trips across chunk boundaries and hides plaintext at rest', async () => {
    const enc = await collect(Readable.from([Buffer.from(cast)]).pipe(createEncryptStream()));
    expect(enc.subarray(0, 6).toString()).toBe('SHREC1');
    expect(enc.includes(Buffer.from('hunter2'))).toBe(false);
    for (const size of [1, 7, 16, 17, 1000]) {
      const dec = await collect(chunked(enc, size).pipe(createDecryptStream()));
      expect(dec.toString()).toBe(cast);
    }
  });

  test('legacy plaintext casts pass through unchanged', async () => {
    const dec = await collect(chunked(Buffer.from(cast), 3).pipe(createDecryptStream()));
    expect(dec.toString()).toBe(cast);
  });

  test('tampering is detected', async () => {
    const enc = await collect(Readable.from([Buffer.from(cast)]).pipe(createEncryptStream()));
    enc[enc.length - 40] ^= 0xff;
    await expect(collect(Readable.from([enc]).pipe(createDecryptStream()))).rejects.toThrow();
  });

  test('empty recording still produces a valid encrypted object', async () => {
    const enc = await collect(Readable.from([]).pipe(createEncryptStream()));
    const dec = await collect(Readable.from([enc]).pipe(createDecryptStream()));
    expect(dec.length).toBe(0);
  });
});
