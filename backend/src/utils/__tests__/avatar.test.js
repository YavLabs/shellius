import { parseAvatarDataUrl, MAX_AVATAR_BYTES } from '../avatar.js';

// Minimal valid magic-byte prefixes for each supported type.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_SIG = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

function toDataUrl(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

describe('parseAvatarDataUrl', () => {
  test('accepts a well-formed PNG data URL', () => {
    const url = toDataUrl('image/png', Buffer.concat([PNG_SIG, Buffer.alloc(100)]));
    const { mime, buffer } = parseAvatarDataUrl(url);
    expect(mime).toBe('image/png');
    expect(buffer.length).toBe(108);
  });

  test('accepts JPEG and WebP', () => {
    expect(parseAvatarDataUrl(toDataUrl('image/jpeg', JPEG_SIG)).mime).toBe('image/jpeg');
    expect(parseAvatarDataUrl(toDataUrl('image/webp', WEBP_SIG)).mime).toBe('image/webp');
  });

  test('rejects a non-data-url string', () => {
    expect(() => parseAvatarDataUrl('not-a-data-url')).toThrow(/data URL/);
  });

  test('rejects an unsupported MIME type', () => {
    const url = `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}`;
    expect(() => parseAvatarDataUrl(url)).toThrow(/data URL/);
  });

  test('rejects content whose magic bytes do not match the declared MIME', () => {
    // Declares PNG but is actually JPEG bytes.
    const url = toDataUrl('image/png', JPEG_SIG);
    expect(() => parseAvatarDataUrl(url)).toThrow(/does not match/);
  });

  test('rejects a payload over the 150KB decoded limit', () => {
    const big = Buffer.concat([PNG_SIG, Buffer.alloc(MAX_AVATAR_BYTES)]); // > limit
    const url = toDataUrl('image/png', big);
    expect(() => parseAvatarDataUrl(url)).toThrow(/150KB|smaller/);
  });

  test('accepts a payload exactly at the 150KB decoded limit', () => {
    const exact = Buffer.concat([PNG_SIG, Buffer.alloc(MAX_AVATAR_BYTES - PNG_SIG.length)]);
    expect(() => parseAvatarDataUrl(toDataUrl('image/png', exact))).not.toThrow();
  });

  test('rejects empty/malformed base64', () => {
    expect(() => parseAvatarDataUrl('data:image/png;base64,')).toThrow();
    expect(() => parseAvatarDataUrl(null)).toThrow();
    expect(() => parseAvatarDataUrl(undefined)).toThrow();
  });
});
