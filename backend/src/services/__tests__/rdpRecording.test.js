/**
 * rdpRecording.test.js
 *
 * RDP recordings are evidence. Every test here is about one of the two ways
 * this feature can betray that: destroying a recording that should have been
 * kept, or keeping one it cannot account for.
 *
 * `db` and `storage` are injected rather than mocked — jest.unstable_mockModule
 * is unreliable under this repo's native-ESM setup (see the note at the top of
 * githubOAuth.test.js). The filesystem is real, in a temp directory.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import * as svc from '../rdpRecordingService.js';
import { createDecryptStream } from '../../utils/recordingCrypto.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

let dir;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shellius-rdprec-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

/** A recording file whose mtime is `ageMs` in the past. */
async function writeRecording(id, { bytes = 'GUACAMOLE-DATA', ageMs = 60_000 } = {}) {
  const p = path.join(dir, `${id}.guac`);
  await fs.promises.writeFile(p, bytes);
  const when = new Date(Date.now() - ageMs);
  await fs.promises.utimes(p, when, when);
  return p;
}

/** A stub Prisma with one session, capturing updates. */
function fakeDb(session) {
  const updates = [];
  return {
    updates,
    session: {
      findFirst: jest.fn(async ({ where }) => {
        if (!session) return null;
        const wanted = where?.metadata?.equals;
        return session.__recordingId === wanted ? session : null;
      }),
      update: jest.fn(async ({ where, data }) => {
        updates.push({ where, data });
        return { ...session, ...data };
      }),
    },
  };
}

/** A stub object store that collects what it was handed. */
function fakeStorage({ fail = false } = {}) {
  const puts = [];
  return {
    puts,
    isConfigured: async () => true,
    putObjectStream: jest.fn(async (key, stream) => {
      if (fail) throw new Error('bucket unreachable');
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      puts.push({ key, body: Buffer.concat(chunks) });
    }),
  };
}

const endedSession = (id = 'sess-1') => ({
  id,
  orgId: 'org-1',
  recordingKey: null,
  endedAt: new Date(),
  __recordingId: UUID,
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('a finished recording', () => {
  test('is uploaded, attached to its session, and removed from disk', async () => {
    const p = await writeRecording(UUID);
    const db = fakeDb(endedSession());
    const storage = fakeStorage();

    const outcome = await svc.ingestFile(`${UUID}.guac`, { db, storage, dir });

    expect(outcome).toBe('stored');
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].key).toBe('sessions/org-1/sess-1.guac');
    expect(db.updates[0].data).toEqual({ recordingKey: 'sessions/org-1/sess-1.guac' });
    await expect(fs.promises.access(p)).rejects.toThrow();
  });

  // A recording is a picture of somebody's desktop. It gets the same envelope
  // an SSH cast gets, and it gets it before it leaves this machine.
  test('is encrypted on the way out, and decrypts back to the original bytes', async () => {
    await writeRecording(UUID, { bytes: 'GUACAMOLE-SECRET-FRAMES' });
    const storage = fakeStorage();
    await svc.ingestFile(`${UUID}.guac`, { db: fakeDb(endedSession()), storage, dir });

    const stored = storage.puts[0].body;
    expect(stored.toString()).not.toContain('GUACAMOLE-SECRET-FRAMES');

    const plain = await new Promise((resolve, reject) => {
      const chunks = [];
      const d = createDecryptStream();
      d.on('data', (c) => chunks.push(c));
      d.on('end', () => resolve(Buffer.concat(chunks).toString()));
      d.on('error', reject);
      d.end(stored);
    });
    expect(plain).toBe('GUACAMOLE-SECRET-FRAMES');
  });
});

// ---------------------------------------------------------------------------
// Not finished yet — the ways a recording gets truncated
// ---------------------------------------------------------------------------

describe('a recording still being written', () => {
  // guacd keeps writing for a moment after the client's tunnel drops.
  // Uploading then would store a truncated file AND delete the rest of it.
  test('is left alone while its mtime is recent', async () => {
    const p = await writeRecording(UUID, { ageMs: 1000 });
    const db = fakeDb(endedSession());
    const storage = fakeStorage();

    expect(await svc.ingestFile(`${UUID}.guac`, { db, storage, dir })).toBe('pending');
    expect(storage.puts).toHaveLength(0);
    await expect(fs.promises.access(p)).resolves.toBeUndefined();
  });

  // An idle desktop draws nothing for minutes, so a stale mtime does NOT mean
  // the session is over. The Session row is the authority on that.
  test('is left alone while its session is still open, however old the file', async () => {
    await writeRecording(UUID, { ageMs: 60 * 60 * 1000 });
    const live = { ...endedSession(), endedAt: null };
    const storage = fakeStorage();

    expect(await svc.ingestFile(`${UUID}.guac`, { db: fakeDb(live), storage, dir })).toBe('pending');
    expect(storage.puts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure — the ways a recording gets lost
// ---------------------------------------------------------------------------

describe('when something goes wrong', () => {
  test('an upload failure keeps the local file for the next pass', async () => {
    const p = await writeRecording(UUID);
    const storage = fakeStorage({ fail: true });

    expect(await svc.ingestFile(`${UUID}.guac`, { db: fakeDb(endedSession()), storage, dir })).toBe('failed');
    await expect(fs.promises.access(p)).resolves.toBeUndefined();
  });

  // The object is in the bucket but nothing points at it. Deleting the local
  // copy here would strand the recording: unreachable, and never pruned.
  test('a database failure after upload keeps the local file too', async () => {
    const p = await writeRecording(UUID);
    const db = fakeDb(endedSession());
    db.session.update = jest.fn(async () => {
      throw new Error('db down');
    });

    expect(await svc.ingestFile(`${UUID}.guac`, { db, storage: fakeStorage(), dir })).toBe('failed');
    await expect(fs.promises.access(p)).resolves.toBeUndefined();
  });

  test('a file that vanished between listing and reading is not an error', async () => {
    expect(
      await svc.ingestFile(`${UUID}.guac`, { db: fakeDb(endedSession()), storage: fakeStorage(), dir })
    ).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Recordings nothing can account for
// ---------------------------------------------------------------------------

describe('an unattributable recording', () => {
  // The Session row is written by the `open` handler, which fires after guacd
  // has already created the file. A few seconds of no match is normal.
  test('is retried while it is young', async () => {
    await writeRecording(OTHER, { ageMs: 60_000 });
    const storage = fakeStorage();
    expect(await svc.ingestFile(`${OTHER}.guac`, { db: fakeDb(null), storage, dir })).toBe('pending');
    expect(storage.puts).toHaveLength(0);
  });

  // It can never be served, shown, or governed by anyone's retention policy.
  // Keeping a screen recording nothing can account for is worse than losing it.
  test('is destroyed once it is past the grace period', async () => {
    const p = await writeRecording(OTHER, { ageMs: 25 * 60 * 60 * 1000 });
    expect(await svc.ingestFile(`${OTHER}.guac`, { db: fakeDb(null), storage: fakeStorage(), dir })).toBe(
      'orphaned'
    );
    await expect(fs.promises.access(p)).rejects.toThrow();
  });

  // guacd creates the file on connect, so an empty one is a connection that
  // failed before drawing anything. There is nothing to watch.
  test('an empty file is discarded without being uploaded', async () => {
    const p = await writeRecording(UUID, { bytes: '' });
    const storage = fakeStorage();
    expect(await svc.ingestFile(`${UUID}.guac`, { db: fakeDb(endedSession()), storage, dir })).toBe('skipped');
    expect(storage.puts).toHaveLength(0);
    await expect(fs.promises.access(p)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The sweeper unlinks files. It must be fussy about which.
// ---------------------------------------------------------------------------

describe('filename handling', () => {
  // `skipped` is returned both for "this name is not a recording" and for
  // "that file is gone", so asserting the return value alone would pass for
  // a name that was never rejected. Each of these files is created first and
  // must still be there afterwards, untouched and unuploaded.
  test.each([
    'not-a-uuid.guac',
    `${UUID}.guac.bak`,
    `${UUID}.cast`,
    '.hidden',
    'AAAAAAAA-2222-4333-8444-555555555555.guac', // uppercase hex is not our format
    `${UUID}.guac `, // trailing space
    `x${UUID}.guac`,
  ])('refuses to act on %s', async (name) => {
    const target = path.join(dir, name);
    await fs.promises.writeFile(target, 'GUACAMOLE-DATA');
    const old = new Date(Date.now() - 60_000);
    await fs.promises.utimes(target, old, old);

    const storage = fakeStorage();
    expect(await svc.ingestFile(name, { db: fakeDb(endedSession()), storage, dir })).toBe('skipped');
    expect(storage.puts).toHaveLength(0);
    // Still on disk: refusing to ingest must not mean deleting.
    await expect(fs.promises.access(target)).resolves.toBeUndefined();
  });

  test('a directory that looks like a recording is not ingested', async () => {
    await fs.promises.mkdir(path.join(dir, `${UUID}.guac`));
    expect(
      await svc.ingestFile(`${UUID}.guac`, { db: fakeDb(endedSession()), storage: fakeStorage(), dir })
    ).toBe('skipped');
  });

  // A traversal name must not reach outside the recordings directory even if
  // the regex were ever loosened.
  test('a traversal name does not touch a file outside the directory', async () => {
    const outside = path.join(dir, '..', `escape-${process.pid}.txt`);
    await fs.promises.writeFile(outside, 'keep me');
    try {
      await svc.ingestFile(`../escape-${process.pid}.txt`, {
        db: fakeDb(endedSession()),
        storage: fakeStorage(),
        dir,
      });
      await expect(fs.promises.readFile(outside, 'utf8')).resolves.toBe('keep me');
    } finally {
      await fs.promises.rm(outside, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('sweep', () => {
  test('counts each outcome and keeps going past a bad file', async () => {
    await writeRecording(UUID);
    await writeRecording(OTHER, { ageMs: 1000 });
    await fs.promises.writeFile(path.join(dir, 'README.txt'), 'not a recording');

    const summary = await svc.sweep({ db: fakeDb(endedSession()), storage: fakeStorage(), dir });

    expect(summary.stored).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.skipped).toBe(1);
    await expect(fs.promises.access(path.join(dir, 'README.txt'))).resolves.toBeUndefined();
  });

  test('a missing directory is not an error', async () => {
    const summary = await svc.sweep({
      db: fakeDb(null),
      storage: fakeStorage(),
      dir: path.join(dir, 'does-not-exist'),
    });
    expect(summary).toEqual({ stored: 0, pending: 0, orphaned: 0, skipped: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// What guacd is told
// ---------------------------------------------------------------------------

describe('recording parameters', () => {
  // The single most important line in this feature. Keystrokes would capture
  // every password typed into the remote desktop, turning an audit artefact
  // into a credential store.
  test('never ask guacd to record keystrokes', () => {
    expect(svc.recordingParamsFor(UUID)['recording-include-keys']).toBe('false');
  });

  test('name the file after the recording id, under the path guacd can see', () => {
    const params = svc.recordingParamsFor(UUID);
    expect(params['recording-name']).toBe(`${UUID}.guac`);
    expect(params['recording-path']).toBe(svc.GUACD_RECORDINGS_DIR);
    expect(params['create-recording-path']).toBe('true');
  });

  test('the ids they are built from are unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => svc.newRecordingId()));
    expect(ids.size).toBe(500);
  });
});

describe('isEnabled', () => {
  test('is false when there is nowhere to put a recording', async () => {
    const storage = { isConfigured: async () => false };
    expect(await svc.isEnabled({ storage, dir })).toBe(false);
  });

  test('is false when the recordings directory cannot be used', async () => {
    const file = path.join(dir, 'a-file-not-a-dir');
    await fs.promises.writeFile(file, 'x');
    expect(await svc.isEnabled({ storage: fakeStorage(), dir: path.join(file, 'nested') })).toBe(false);
  });

  // A storage backend that throws must disable recording, not break RDP.
  test('is false rather than throwing when the storage check fails', async () => {
    const storage = {
      isConfigured: async () => {
        throw new Error('config unreadable');
      },
    };
    expect(await svc.isEnabled({ storage, dir })).toBe(false);
  });

  test('is true when storage is configured and the directory is writable', async () => {
    expect(await svc.isEnabled({ storage: fakeStorage(), dir })).toBe(true);
  });
});
