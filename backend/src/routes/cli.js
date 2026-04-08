/**
 * cli.js — serve the Shellius CLI (TUI) installer script directly from
 * the deployment. Lets developers run:
 *
 *   curl -fsSL https://shellius.example.com/api/cli/install.sh | sh
 *
 * ...without needing to hit GitHub at all. The script is read from
 * scripts/install-tui.sh on disk at request time (not cached at module
 * load) so operators can tweak it without a backend restart.
 *
 * Public endpoint — no auth. The script itself is non-secret and the
 * binaries it downloads are signed + checksummed.
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const router = express.Router();

// Resolve scripts/install-tui.sh relative to this file. Backend ships
// with /app/src/routes/cli.js inside the container; the script lives
// at /app/scripts/install-tui.sh (see docker/Dockerfile.backend which
// copies both).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'install-tui.sh');
// Fallback: also look in /app/scripts inside a Docker image that
// doesn't use the project root layout.
const SCRIPT_PATH_DOCKER = '/app/scripts/install-tui.sh';

async function findScript() {
  for (const p of [SCRIPT_PATH, SCRIPT_PATH_DOCKER]) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

router.get('/install.sh', async (req, res, next) => {
  try {
    const scriptPath = await findScript();
    if (!scriptPath) {
      logger.warn('cli: install-tui.sh not found on disk', {
        tried: [SCRIPT_PATH, SCRIPT_PATH_DOCKER],
      });
      res.status(404).type('text/plain').send(
        '# Shellius CLI installer is not available on this deployment.\n' +
          '# The backend container is missing scripts/install-tui.sh.\n' +
          '# Download the binary manually from the GitHub release.\n'
      );
      return;
    }
    const body = await fs.readFile(scriptPath, 'utf8');
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

export default router;
