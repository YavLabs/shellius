/**
 * rdpRecordingService.js — session recording for RDP.
 *
 * SSH recording and RDP recording look similar from the Sessions page and are
 * nothing alike underneath. An SSH session's bytes pass through this process,
 * so `terminalService.openRecordingWriter` streams them straight into object
 * storage and never touches a disk. **RDP bytes never pass through Node at
 * all** — guacd draws the session and, when told to, writes its own recording
 * to its own filesystem. Node cannot stream what it does not see.
 *
 * So the shape here is different, and the difference drives every decision:
 *
 *   1. guacd is told a path and a name before the connection opens, because a
 *      recording parameter cannot be added to a connection already in flight.
 *      That is earlier than the Session row exists, so the file is named after
 *      a freshly minted recording id and the Session row records which id is
 *      its own.
 *   2. The file is only complete once guacd closes it, and guacd closes it
 *      slightly after the client's WebSocket goes away. Uploading on close
 *      would race the last flush, so a sweeper picks up files that have been
 *      untouched for a while instead.
 *   3. A sweeper also survives a restart mid-session, which an upload on close
 *      does not. For an evidence trail that matters more than promptness.
 *
 * The recording is encrypted with the same envelope as an SSH cast before it
 * leaves this machine, and the plaintext file is deleted once the ciphertext
 * is safely in the bucket.
 *
 * KEYSTROKES ARE DELIBERATELY NOT RECORDED. `recording-include-keys` stays
 * off: it would capture every password typed into the remote desktop, which
 * turns an audit artefact into a credential store.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as storageService from './storageService.js';
import { createEncryptStream } from '../utils/recordingCrypto.js';

/**
 * Where the backend looks for finished recordings, and where guacd is told to
 * write them.
 *
 * These are two settings because they are two filesystems. guacd runs in its
 * own container; the path it writes to is the path inside that container,
 * which is not necessarily the path this process reads from. They default to
 * the same value because the common deployment bind-mounts one directory into
 * both, and a single setting is one fewer thing to get wrong.
 */
export const RECORDINGS_DIR = process.env.RDP_RECORDINGS_DIR || './data/rdp-recordings';

/**
 * The same directory as guacd sees it.
 *
 * This does NOT default to `RECORDINGS_DIR`, and that is the whole point: the
 * backend's default is a relative path, which is meaningful from wherever the
 * backend was started and meaningless to guacd, whose working directory is
 * `/`. Sending guacd a relative `recording-path` makes it try to create a
 * directory it has no permission to create, record nothing, and report success
 * — the session works perfectly and the recording simply never exists.
 *
 * So this defaults to the absolute path every compose file mounts the shared
 * volume at, which is correct in development too: there the backend reads the
 * host side of a bind mount while guacd writes the container side of the same
 * directory.
 */
export const GUACD_RECORDINGS_DIR =
  process.env.GUACD_RDP_RECORDINGS_DIR || '/var/lib/shellius/rdp-recordings';

/**
 * How long a file must sit untouched before it is considered finished.
 *
 * guacd closes its recording after the client tunnel drops, so a file is still
 * being written for a short while after Shellius believes the session ended.
 * Uploading early would store a truncated recording and — worse — delete the
 * rest of it.
 */
export const STABLE_AFTER_MS = Number(process.env.RDP_RECORDING_STABLE_MS || 30 * 1000);

/**
 * How long an unattributable recording is kept before it is destroyed.
 *
 * A file whose recording id matches no Session row cannot be served to anyone,
 * shown to anyone, or governed by anyone's retention policy. Keeping a
 * screen recording that nothing can account for is worse than losing it, so
 * after this long it is deleted and the deletion is logged loudly.
 */
export const ORPHAN_GRACE_MS = Number(process.env.RDP_RECORDING_ORPHAN_GRACE_MS || 24 * 60 * 60 * 1000);

/**
 * Recording ids are v4 UUIDs and the filename is the id plus `.guac`.
 *
 * Matched strictly before the name is ever joined onto a path. guacd writes
 * these names itself so a hostile one is not the expected case, but a sweeper
 * that unlinks whatever it finds in a directory should not be one surprising
 * file away from deleting something else.
 */
const RECORDING_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.guac$/;

export function newRecordingId() {
  return crypto.randomUUID();
}

/**
 * The guacd connection parameters that turn recording on.
 *
 * `create-recording-path` lets guacd make the directory itself, so a fresh
 * deployment does not need the volume pre-created with the right owner.
 */
export function recordingParamsFor(recordingId) {
  return {
    'recording-path': GUACD_RECORDINGS_DIR,
    'recording-name': `${recordingId}.guac`,
    'create-recording-path': 'true',
    // Output only. Keys would capture typed passwords; the mouse is kept
    // because pointer movement is most of what makes a replay legible.
    'recording-include-keys': 'false',
  };
}

/**
 * Whether recording can work at all right now.
 *
 * Both halves are required and neither is worth an error: an installation
 * with no object storage has nowhere to put a recording, and one whose guacd
 * volume is not shared cannot hand the file over. In both cases the session
 * itself is fine and must not be blocked — RDP access is the feature, the
 * recording is evidence about it.
 */
export async function isEnabled({
  storage = storageService,
  dir = RECORDINGS_DIR,
  guacdDir = GUACD_RECORDINGS_DIR,
} = {}) {
  if (process.env.RDP_RECORDING_ENABLED === 'false') return false;

  // A relative path is resolved by guacd against ITS working directory, which
  // is `/`. It would try to create a directory it cannot create, record
  // nothing, and never say so. Refusing here turns a silent absence of
  // evidence into a line in the log.
  if (!path.isAbsolute(guacdDir)) {
    logger.warn('rdpRecording: GUACD_RDP_RECORDINGS_DIR must be an absolute path; recording disabled', {
      guacdDir,
    });
    return false;
  }
  try {
    if (!(await storage.isConfigured())) return false;
  } catch (err) {
    logger.warn('rdpRecording: storage check failed; recording disabled', { error: err.message });
    return false;
  }
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (err) {
    logger.warn('rdpRecording: recordings directory unusable; recording disabled', {
      dir,
      error: err.message,
    });
    return false;
  }
}

/**
 * The Session row that owns a recording id, or null.
 *
 * `db` and `storage` are injected throughout this module rather than mocked:
 * jest.unstable_mockModule is unreliable under this repo's native-ESM setup
 * (see the note at the top of services/__tests__/githubOAuth.test.js), so
 * injection is how everything else here is made testable.
 */
async function sessionForRecording(recordingId, db) {
  return db.session.findFirst({
    where: {
      sessionType: 'RDP',
      metadata: { path: ['recordingId'], equals: recordingId },
    },
    select: { id: true, orgId: true, recordingKey: true, endedAt: true },
  });
}

/**
 * Take one finished recording into object storage.
 *
 * Order matters and is not arbitrary: upload, then record the key, then
 * delete. Deleting before the key is written would lose the recording
 * entirely; a crash between upload and key means the next sweep re-uploads
 * over the same key, which is harmless.
 *
 * @returns {Promise<'stored'|'pending'|'orphaned'|'skipped'|'failed'>}
 */
export async function ingestFile(
  filename,
  { now = new Date(), db = prisma, storage = storageService, dir = RECORDINGS_DIR } = {}
) {
  if (!RECORDING_FILE.test(filename)) {
    logger.warn('rdpRecording: ignoring unexpected file in recordings directory', { filename });
    return 'skipped';
  }
  const recordingId = filename.replace(/\.guac$/, '');
  const filePath = path.join(dir, filename);

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return 'skipped'; // taken by a concurrent sweep
    throw err;
  }
  if (!stat.isFile()) return 'skipped';

  // Still being written to.
  if (now.getTime() - stat.mtimeMs < STABLE_AFTER_MS) return 'pending';

  // guacd creates the file when the connection opens, so a zero-byte one is a
  // connection that failed before drawing anything. There is nothing to watch.
  if (stat.size === 0) {
    await fs.promises.unlink(filePath).catch(() => {});
    return 'skipped';
  }

  const session = await sessionForRecording(recordingId, db);
  if (!session) {
    const age = now.getTime() - stat.mtimeMs;
    if (age < ORPHAN_GRACE_MS) return 'pending';
    logger.error('rdpRecording: destroying a recording no session claims', {
      recordingId,
      ageHours: Math.round(age / 3_600_000),
      bytes: stat.size,
    });
    await fs.promises.unlink(filePath).catch(() => {});
    return 'orphaned';
  }

  // A session that has not ended yet is still being recorded, whatever the
  // mtime says — an idle desktop draws nothing for minutes at a time.
  if (!session.endedAt) return 'pending';

  const recordingKey = `sessions/${session.orgId}/${session.id}.guac`;

  try {
    const plain = fs.createReadStream(filePath);
    // Encrypted before it leaves this machine, exactly like an SSH cast: a
    // recording is a picture of someone's desktop.
    const encrypted = plain.pipe(createEncryptStream());
    await storage.putObjectStream(recordingKey, encrypted, {
      contentType: 'application/octet-stream',
      metadata: {
        'x-amz-meta-session-id': session.id,
        'x-amz-meta-org-id': session.orgId,
        'x-amz-meta-format': 'guacamole',
      },
    });
  } catch (err) {
    logger.error('rdpRecording: upload failed; keeping the local file', {
      sessionId: session.id,
      error: err.message,
    });
    return 'failed';
  }

  try {
    await db.session.update({ where: { id: session.id }, data: { recordingKey } });
  } catch (err) {
    // The object is in the bucket but nothing points at it. Leave the local
    // file so the next sweep tries again rather than stranding the recording.
    logger.error('rdpRecording: could not attach the recording to its session', {
      sessionId: session.id,
      error: err.message,
    });
    return 'failed';
  }

  await fs.promises.unlink(filePath).catch((err) => {
    logger.warn('rdpRecording: uploaded but could not delete the local copy', {
      sessionId: session.id,
      error: err.message,
    });
  });

  logger.info('rdpRecording: stored', { sessionId: session.id, recordingKey, bytes: stat.size });
  return 'stored';
}

/** One pass over the recordings directory. Never throws. */
export async function sweep({ now = new Date(), db = prisma, storage = storageService, dir = RECORDINGS_DIR } = {}) {
  const summary = { stored: 0, pending: 0, orphaned: 0, skipped: 0, failed: 0 };
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('rdpRecording: cannot read recordings directory', {
        dir,
        error: err.message,
      });
    }
    return summary;
  }

  for (const name of names) {
    try {
      const outcome = await ingestFile(name, { now, db, storage, dir });
      summary[outcome] = (summary[outcome] || 0) + 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn('rdpRecording: sweep failed on a file', { filename: name, error: err.message });
    }
  }
  return summary;
}

export default {
  RECORDINGS_DIR,
  GUACD_RECORDINGS_DIR,
  STABLE_AFTER_MS,
  ORPHAN_GRACE_MS,
  newRecordingId,
  recordingParamsFor,
  isEnabled,
  ingestFile,
  sweep,
};
