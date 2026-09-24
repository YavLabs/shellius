/**
 * The posture collector version this deployment installs — the VERSION= line
 * of the collector script it ships (scripts/posture/shellius-posture-collect.sh,
 * copied to /app/scripts/posture in the image).
 *
 * Its own module, rather than an export of routes/bootstrap.js, so services
 * (the bulk planner, the Server page's posture read) can compare a host's
 * reported version with it without importing a router.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture-collect.sh'),
  '/app/scripts/posture/shellius-posture-collect.sh',
];

function read() {
  for (const p of CANDIDATES) {
    try {
      const m = /^VERSION="([^"]+)"/m.exec(fs.readFileSync(p, 'utf8'));
      if (m) return m[1];
    } catch {
      /* next */
    }
  }
  return null;
}

export const POSTURE_COLLECTOR_VERSION = read();

/**
 * The collector script's bytes, for serving to a host that has been offered
 * an update.
 *
 * Read fresh rather than cached at module load, unlike the version above: the
 * bytes are what get signed and what a host executes, so they must be the
 * ones on disk right now. A cached copy that outlived a redeploy would be
 * signed correctly and be the wrong script.
 *
 * @returns {Buffer|null}
 */
export function readCollectorScript() {
  for (const p of CANDIDATES) {
    try {
      return fs.readFileSync(p);
    } catch {
      /* next */
    }
  }
  return null;
}

/** Dotted-version compare; an unknown current version counts as older. */
export function isOlderCollector(current, latest = POSTURE_COLLECTOR_VERSION) {
  if (!latest) return false;
  if (!current) return true;
  const a = String(current).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const b = String(latest).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

export default { POSTURE_COLLECTOR_VERSION, isOlderCollector, readCollectorScript };
