/**
 * zip.js — minimal, dependency-free ZIP builder (STORE / no compression).
 *
 * Used to bundle the ephemeral SSH key + certificate + helper files into a
 * SINGLE download. Browsers block the 2nd, 3rd, ... programmatic download
 * fired in quick succession from one click, which is why downloading the key
 * and cert as separate files dropped the cert. One archive = one download =
 * always works.
 *
 * Stored (uncompressed) entries are sufficient here — the payloads are tiny —
 * and keep this to ~60 lines with no external library. Unix file modes are
 * written into the central-directory external attributes so `unzip` restores
 * the private key as 0600 where the tool honours it.
 */

const enc = new TextEncoder();

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

const u16 = (n) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
};
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Build a ZIP archive Blob.
 *
 * @param {Array<{ name: string, data: string|Uint8Array, unixMode?: number }>} files
 * @returns {Blob}
 */
export function createZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;
    const flag = 0x0800; // UTF-8 filename

    // Local file header + data
    const local = concat([
      u32(0x04034b50), u16(20), u16(flag), u16(0), // sig, ver-needed, flag, method=store
      u16(0), u16(0),                              // mod time, mod date
      u32(crc), u32(size), u32(size),              // crc, compressed, uncompressed
      u16(nameBytes.length), u16(0),               // name len, extra len
      nameBytes,
    ]);
    localChunks.push(local, dataBytes);

    // Central directory header
    const externalAttr = ((f.unixMode ?? 0o100644) & 0xffff) << 16;
    centralChunks.push(concat([
      u32(0x02014b50), u16(0x031e), u16(20), u16(flag), u16(0), // sig, ver-made(unix), ver-needed, flag, method
      u16(0), u16(0),                              // mod time, mod date
      u32(crc), u32(size), u32(size),              // crc, compressed, uncompressed
      u16(nameBytes.length), u16(0), u16(0),       // name, extra, comment lengths
      u16(0), u16(0),                              // disk #, internal attrs
      u32(externalAttr), u32(offset),              // external attrs, local header offset
      nameBytes,
    ]));

    offset += local.length + dataBytes.length;
  }

  const central = concat(centralChunks);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(central.length), u32(offset),
    u16(0),
  ]);

  return new Blob([concat(localChunks), central, end], { type: 'application/zip' });
}
