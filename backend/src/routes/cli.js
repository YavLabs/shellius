/**
 * cli.js — serve the Shellius CLI (TUI) installer AND its binaries
 * directly from the deployment. Lets developers run:
 *
 *   curl -fsSL https://shellius.example.com/api/cli/install.sh | sh
 *
 * ...without needing to hit GitHub at all. Critical for self-hosted,
 * private-repo deployments where the GitHub releases API is gated
 * behind a token.
 *
 * Endpoints (all public — the artifacts are non-secret and the
 * installer verifies their SHA-256 sums):
 *
 *   GET /api/cli/install.sh
 *       → the installer shell script (from scripts/install-tui.sh)
 *
 *   GET /api/cli/version
 *       → { version, commit, buildTime, binaries[] } read from
 *         /app/tui-bin/version.txt + a listdir of allowed binaries.
 *
 *   GET /api/cli/bin/:file
 *       → raw binary download
 *         :file ∈ { shellius-<os>-<arch>[.exe], *.sha256 }
 *         Backed by /app/tui-bin/<file> inside the container.
 */

import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT_PATHS = [
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'install-tui.sh'),
  '/app/scripts/install-tui.sh',
];

// Directory where pre-built TUI binaries live. Populated by
// scripts/build-tui-binaries.sh or the release workflow.
const BIN_DIRS = [
  path.resolve(__dirname, '..', '..', '..', 'tui-bin'),
  '/app/tui-bin',
];

// Whitelist of binary filenames we'll serve. Anything else → 404.
// Prevents path traversal and accidental exposure of unrelated files.
const ALLOWED_BINARIES = new Set([
  'shellius-linux-amd64',
  'shellius-linux-amd64.sha256',
  'shellius-linux-arm64',
  'shellius-linux-arm64.sha256',
  'shellius-darwin-amd64',
  'shellius-darwin-amd64.sha256',
  'shellius-darwin-arm64',
  'shellius-darwin-arm64.sha256',
  'shellius-windows-amd64.exe',
  'shellius-windows-amd64.exe.sha256',
  'version.txt',
]);

async function findFirstExisting(paths) {
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/cli/install.sh
// ---------------------------------------------------------------------------
router.get('/install.sh', async (req, res, next) => {
  try {
    const scriptPath = await findFirstExisting(SCRIPT_PATHS);
    if (!scriptPath) {
      logger.warn('cli: install-tui.sh not found on disk', { tried: SCRIPT_PATHS });
      res
        .status(404)
        .type('text/plain')
        .send(
          '# Shellius CLI installer is not available on this deployment.\n' +
            '# The backend container is missing scripts/install-tui.sh.\n'
        );
      return;
    }
    const rawBody = await fs.readFile(scriptPath, 'utf8');

    // Inject SHELLIUS_HOST so the one-liner `curl ... | sh` works without
    // the user having to set the env var manually. When piped into sh,
    // the script otherwise has no way to know which deployment served it.
    // We honor X-Forwarded-* (Express `trust proxy` must be enabled) so
    // the URL matches what the browser sees behind nginx/Traefik.
    const host = req.get('x-forwarded-host') || req.get('host');
    // Force https for any non-local host. The Cloudflare → Traefik → nginx
    // → backend chain doesn't reliably preserve X-Forwarded-Proto (some
    // inner hops rewrite it to http), but production traffic is always
    // TLS-terminated at the edge. Localhost stays http for dev.
    const isLocal = host && /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host);
    const proto = isLocal ? 'http' : 'https';
    let body = rawBody;
    if (host) {
      const injected = `${proto}://${host}`.replace(/\/+$/, '');
      // Insert immediately after the shebang so `set -e` and everything
      // else still runs in order. Use single quotes — the URL never
      // contains them and we don't want shell expansion.
      body = rawBody.replace(
        /^(#![^\n]*\n)/,
        `$1SHELLIUS_HOST='${injected}'\nexport SHELLIUS_HOST\n`
      );
    }

    res.set({
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline; filename="install-tui.sh"',
    });
    res.send(body);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cli/version
// ---------------------------------------------------------------------------
router.get('/version', async (req, res, next) => {
  try {
    const binDir = await findFirstExisting(BIN_DIRS);
    if (!binDir) {
      res.status(404).json({
        success: false,
        error: {
          code: 'CLI_BINARIES_NOT_PRESENT',
          message:
            'No Shellius CLI binaries are present on this deployment. ' +
            'Run scripts/build-tui-binaries.sh on the host and rebuild the ' +
            'backend image, or mount a release tarball into /app/tui-bin.',
        },
      });
      return;
    }
    let version = 'unknown';
    let commit = 'unknown';
    let buildTime = 'unknown';
    try {
      const raw = await fs.readFile(path.join(binDir, 'version.txt'), 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k === 'version') version = v;
        if (k === 'commit') commit = v;
        if (k === 'build_time') buildTime = v;
      }
    } catch {
      /* version.txt is optional */
    }
    const dirEntries = await fs.readdir(binDir);
    const binaries = dirEntries
      .filter((f) => ALLOWED_BINARIES.has(f) && f !== 'version.txt')
      .sort();

    res.json({
      success: true,
      data: { version, commit, buildTime, binaries },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cli/bin/:file
// ---------------------------------------------------------------------------
router.get('/bin/:file', async (req, res, next) => {
  try {
    const file = req.params.file;
    if (!ALLOWED_BINARIES.has(file)) {
      res.status(404).type('text/plain').send(`unknown binary: ${file}\n`);
      return;
    }
    const binDir = await findFirstExisting(BIN_DIRS);
    if (!binDir) {
      res
        .status(404)
        .type('text/plain')
        .send('# No CLI binaries present on this deployment.\n');
      return;
    }
    const full = path.join(binDir, file);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      res.status(404).type('text/plain').send(`binary not found: ${file}\n`);
      return;
    }
    const isChecksum = file.endsWith('.sha256');
    res.set({
      'Content-Type': isChecksum ? 'text/plain' : 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'public, max-age=300',
    });
    const stream = fsSync.createReadStream(full);
    stream.on('error', (err) => {
      logger.warn('cli: binary stream error', { file, error: err.message });
      res.destroy(err);
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
