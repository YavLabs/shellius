import redis from '../config/redis.js';
import crypto from 'crypto';
/**
 * bootstrap.js
 *
 * Endpoints for bootstrapping a target host so it trusts the Shellius CA
 * and consults the Shellius API on every SSH connection via a
 * check-principals script.
 *
 * Flow:
 *   1. Frontend (admin) calls POST /api/bootstrap/token { serverId }.
 *      → returns a short-lived JWT + copy/paste one-liners per OS.
 *   2. User runs the one-liner on the target host. The one-liner pipes
 *      GET /api/bootstrap/install.sh?token=... (or install.ps1) to the
 *      appropriate shell, which installs the CA pub key, the agent
 *      per-host agent token, the check-principals script, and updates sshd_config.
 *
 * The install endpoints are public (no Bearer auth) but require a valid
 * bootstrap JWT in the ?token query parameter. The JWT binds the script
 * to a specific server + org and expires in 30 minutes.
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import audit from '../middleware/audit.js';
import { requirePermission } from '../middleware/rbac.js';
import config from '../config/index.js';
import prisma from '../config/db.js';
import * as caService from '../services/caService.js';
import { generateAgentToken } from '../utils/agentToken.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { serverScopeWhere } from '../lib/scope.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Posture collector artifacts — read from disk, same dual-path resolution
// routes/cli.js uses for scripts/install-tui.sh (dev path relative to this
// file, prod path inside the backend container). Kept as plain files rather
// than inlined JS template-literal text because that inlining technique
// (see buildUnixInstallScript's check-principals block) silently drops a
// trailing '\' when the character sequence "\'" appears in the source —
// backslash-line-continuation inside the generated script gets eaten by
// JS's own template-literal escaping. Reading real .sh/.service/.timer/
// .sudoers files sidesteps that trap entirely and gives a single source of
// truth that `bash -n` / `shellcheck` / `systemd-analyze verify` / `visudo
// -c` can lint directly (see scripts/posture/).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSTURE_ASSET_PATHS = {
  collect: [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture-collect.sh'),
    '/app/scripts/posture/shellius-posture-collect.sh',
  ],
  report: [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture-report.sh'),
    '/app/scripts/posture/shellius-posture-report.sh',
  ],
  service: [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture.service'),
    '/app/scripts/posture/shellius-posture.service',
  ],
  timer: [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture.timer'),
    '/app/scripts/posture/shellius-posture.timer',
  ],
  containerSudoers: [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture-containers.sudoers'),
    '/app/scripts/posture/shellius-posture-containers.sudoers',
  ],
  sudoers: [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'posture', 'shellius-posture.sudoers'),
    '/app/scripts/posture/shellius-posture.sudoers',
  ],
};

function readFirstExistingSync(paths) {
  for (const p of paths) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* next */
    }
  }
  return null;
}

// Loaded once at process start — these are static, checked-in files, not
// per-request data. A missing file degrades the generated install script
// (posture steps are skipped with a warning) rather than 500ing the whole
// bootstrap flow; CA trust + check-principals must never depend on posture
// packaging being present.
const POSTURE_ASSETS = {
  collect: readFirstExistingSync(POSTURE_ASSET_PATHS.collect),
  report: readFirstExistingSync(POSTURE_ASSET_PATHS.report),
  service: readFirstExistingSync(POSTURE_ASSET_PATHS.service),
  timer: readFirstExistingSync(POSTURE_ASSET_PATHS.timer),
  sudoers: readFirstExistingSync(POSTURE_ASSET_PATHS.sudoers),
  containerSudoers: readFirstExistingSync(POSTURE_ASSET_PATHS.containerSudoers),
};
if (Object.values(POSTURE_ASSETS).some((v) => v === null)) {
  logger.warn('bootstrap: posture collector assets missing on disk — install.sh will skip posture packaging', {
    tried: POSTURE_ASSET_PATHS,
  });
}

/**
 * The collector version this deployment installs — the VERSION= line of the
 * collector script it ships. The Server page compares a host's reported
 * version with it, so an outdated collector says "reinstall to update"
 * instead of looking current.
 */
export const POSTURE_COLLECTOR_VERSION =
  (POSTURE_ASSETS.collect && /^VERSION="([^"]+)"/m.exec(POSTURE_ASSETS.collect)?.[1]) || null;

const BOOTSTRAP_TTL_SECONDS = 30 * 60; // 30 min

// Install modes:
//   'full'    (default) — CA trust + sshd + check-principals + JIT +
//             heartbeat + the posture collector bundle. Today's only
//             behaviour until 'ssh' and 'posture' were added.
//   'ssh'     — everything 'full' installs EXCEPT the posture collector: no
//               shellius-posture.{service,timer}, no its sudoers drop-in, no
//               'shellius-posture' account. Same CA trust / sshd config /
//               check-principals / JIT / heartbeat as 'full'. For callers
//               who want SSH cert bootstrap without opting the host into
//               posture collection (yet, or at all).
//   'posture' — the reduced installer for authMode: 'credential' hosts,
//               which deliberately never run bootstrap today
//               (ServerDetail.jsx hides it for them) and are therefore a
//               permanent posture blind spot — see
//               docs/posture/posture-spec.md §4. It installs ONLY the
//               posture collector, its systemd unit/timer, its sudoers
//               drop-in, and the per-host agent token; it never touches
//               sshd, CA trust, AuthorizedPrincipalsCommand, JIT, or
//               check-principals.
//
// The mode travels INSIDE the signed JWT (payload.mode), not as a separate
// query parameter on install.sh/uninstall.sh — the one-liner URL only ever
// carries `?token=...`, so there is no `&mode=...` query string for anyone
// to edit. A caller picks the mode once, at mint time
// (`POST /api/bootstrap/token { serverId, mode }`), and the signature makes
// it tamper-proof from then on; install.sh reads `payload.mode` exclusively.
export const INSTALL_MODES = ['full', 'ssh', 'posture'];

// Exported so other mint sites (currently POST /api/servers/:id/provision —
// see routes/servers.js) sign the exact same claim shape instead of hand
// rolling their own jwt.sign call, which could silently drift from what
// verifyBootstrapToken below expects.
export function signBootstrapToken({ serverId, orgId, mode }) {
  return jwt.sign(
    { kind: 'bootstrap', serverId, orgId, mode: mode || 'full', jti: crypto.randomUUID() },
    config.jwt.secret,
    { expiresIn: BOOTSTRAP_TTL_SECONDS }
  );
}

// Install / uninstall links are SINGLE-USE. The token rides in the URL query
// (it's a `curl … | bash` one-liner), so it can end up in proxy access logs;
// burning it on first download means a logged link is useless — and a replay
// can't mint a fresh per-host agent token (which would also rotate the real
// host's token out). A retry needs a newly generated link.
async function consumeOneTimeToken(payload) {
  if (!payload.jti) return; // links issued before single-use existed (≤30 min)
  const ttl = Math.max(1, (payload.exp || 0) - Math.floor(Date.now() / 1000));
  const fresh = await redis.set(`bootstrap:used:${payload.jti}`, '1', 'EX', ttl, 'NX');
  if (fresh !== 'OK') {
    throw new ApiError(410, 'This install link has already been used. Generate a new one from Shellius.', {
      code: 'LINK_ALREADY_USED',
    });
  }
}

function verifyBootstrapToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  if (payload.kind !== 'bootstrap') throw new Error('Invalid token kind');
  // Links minted before mode existed have no `mode` claim — treat them as
  // 'full', the only behaviour that ever existed until now. Any other value
  // (can only get here via a forged/tampered signature, since we control
  // every mint site) also falls back to 'full', the safer/stricter default.
  payload.mode = INSTALL_MODES.includes(payload.mode) ? payload.mode : 'full';
  return payload;
}

function getPublicBaseUrl(req) {
  // Single source of truth in prod: TRAEFIK_HOST (also used by the Traefik
  // router rule in docker-compose.prod.yml). Always HTTPS.
  // Fallbacks: PUBLIC_API_URL (explicit absolute URL, useful for non-Traefik
  // setups), VITE_API_URL (dev), then incoming request headers.
  const strip = (u) => String(u).replace(/\/$/, '').replace(/\/api$/, '');

  if (process.env.TRAEFIK_HOST) return `https://${process.env.TRAEFIK_HOST}`;
  if (process.env.PUBLIC_API_URL) return strip(process.env.PUBLIC_API_URL);
  if (process.env.VITE_API_URL) return strip(process.env.VITE_API_URL);

  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/**
 * Mint a fresh per-host agent token for a server and persist only its hash.
 * Called every time an install script is actually generated (install.sh /
 * install.ps1 GET) — including on --upgrade and on re-runs, which is how
 * this credential "rotates": the old token's hash is overwritten, so the
 * previous plaintext (if ever exfiltrated) stops working immediately.
 * Returns the ONE-TIME plaintext token to embed in the script. Never log it.
 *
 * @param {string} serverId
 * @returns {Promise<string>} plaintext agent token (shag_...)
 */
async function mintAgentToken(serverId) {
  const { token, hash } = generateAgentToken();
  await prisma.server.update({
    where: { id: serverId },
    data: { agentTokenHash: hash, agentTokenIssuedAt: new Date() },
  });
  logger.info('bootstrap: minted per-host agent token', { serverId });
  return token;
}

// ---------------------------------------------------------------------------
// POST /api/bootstrap/token — authenticated
// ---------------------------------------------------------------------------

// `mode` defaults to 'full' (today's behaviour, unchanged for every existing
// caller that doesn't pass it). 'posture' mints a link to the reduced
// installer — see INSTALL_MODES above and docs/posture/posture-spec.md §4.
const tokenSchema = Joi.object({
  serverId: Joi.string().required(),
  mode: Joi.string().valid(...INSTALL_MODES).default('full'),
});

router.post(
  '/token',
  authenticate,
  tenant,
  requirePermission('servers.onboard'),
  audit('bootstrap.link.created', 'Server'),
  asyncHandler(async (req, res) => {
    const { error, value } = tokenSchema.validate(req.body);
    if (error) throw new ApiError(400, error.message);

    // Customer scope: the token this mints is a working `curl … | sudo bash`
    // bound to that server's CA trust, so it must be unavailable for a server
    // the caller cannot see (docs/rbac/customer-scope-spec.md §4.2 #32).
    // Applies to BOTH modes — posture-only links are just as much a working
    // credential for that specific server as full-mode ones.
    const server = await prisma.server.findFirst({
      where: { id: value.serverId, orgId: req.orgId, ...serverScopeWhere(req.scope) },
      select: { id: true, hostname: true, osType: true, sshUser: true, protocol: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    // Auto-provision the org's SSH CA on first bootstrap if missing — the
    // FULL install script needs the CA public key baked in. Without this,
    // the user would have to manually visit /settings/ca first, which is
    // bad UX. Skipped entirely for posture-only mode: that script never
    // touches CA trust, so minting one has no business creating org CA
    // material as a side effect.
    if (value.mode !== 'posture') {
      try {
        await caService.getPublicKey(req.orgId);
      } catch (err) {
        if (err?.statusCode === 404) {
          await caService.generateCaKeyPair(req.orgId, 'default');
        } else {
          throw err;
        }
      }
    }

    const token = signBootstrapToken({ serverId: server.id, orgId: req.orgId, mode: value.mode });
    const base = getPublicBaseUrl(req);

    const shUrl = `${base}/api/bootstrap/install.sh?token=${token}`;
    const ps1Url = `${base}/api/bootstrap/install.ps1?token=${token}`;

    const commands = {
      linux: `curl -fsSL "${shUrl}" | sudo bash`,
      macos: `curl -fsSL "${shUrl}" | sudo bash`,
      windows: `powershell -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing '${ps1Url}' | iex"`,
    };

    res.json({
      success: true,
      data: {
        server: {
          id: server.id,
          hostname: server.hostname,
          osType: server.osType || null,
          sshUser: server.sshUser,
          protocol: server.protocol,
        },
        mode: value.mode,
        expiresInSeconds: BOOTSTRAP_TTL_SECONDS,
        commands,
        urls: { sh: shUrl, ps1: ps1Url },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/bootstrap/install.sh — public, token-gated
// ---------------------------------------------------------------------------

router.get(
  '/install.sh',
  asyncHandler(async (req, res) => {
    const token = req.query.token;
    if (!token) throw new ApiError(400, 'Missing token');

    let payload;
    try {
      payload = verifyBootstrapToken(token);
    } catch {
      throw new ApiError(401, 'Invalid or expired bootstrap token');
    }
    await consumeOneTimeToken(payload);

    const server = await prisma.server.findFirst({
      where: { id: payload.serverId, orgId: payload.orgId },
      select: { id: true, hostname: true, sshUser: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    // Mode comes exclusively from the verified JWT (verifyBootstrapToken
    // above already normalizes it to a known value) — there is no `?mode=`
    // query parameter for this route, so nothing in the URL a user can edit
    // affects which script they get. See INSTALL_MODES.
    const agentToken = await mintAgentToken(server.id);
    const apiUrl = getPublicBaseUrl(req);

    let script;
    if (payload.mode === 'posture') {
      // Posture-only: no CA public key needed or fetched — this mode never
      // touches SSH trust.
      script = buildPostureOnlyInstallScript({
        apiUrl,
        agentToken,
        hostname: server.hostname,
      });
    } else {
      // 'full' or 'ssh' — both run the CA-trust/sshd/check-principals
      // bootstrap; the only difference is whether the posture collector
      // bundle (steps 10-11) is layered on top. See buildUnixInstallScript.
      const caPubKey = await caService.getPublicKey(payload.orgId);
      script = buildUnixInstallScript({
        apiUrl,
        agentToken,
        caPubKey: caPubKey.trim(),
        hostname: server.hostname,
        sshUser: server.sshUser || 'root',
        serverId: payload.serverId,
        orgId: payload.orgId,
        mode: payload.mode,
      });
    }

    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  })
);

// ---------------------------------------------------------------------------
// GET /api/bootstrap/install.ps1 — public, token-gated
// ---------------------------------------------------------------------------

router.get(
  '/install.ps1',
  asyncHandler(async (req, res) => {
    const token = req.query.token;
    if (!token) throw new ApiError(400, 'Missing token');

    let payload;
    try {
      payload = verifyBootstrapToken(token);
    } catch {
      throw new ApiError(401, 'Invalid or expired bootstrap token');
    }
    await consumeOneTimeToken(payload);

    const server = await prisma.server.findFirst({
      where: { id: payload.serverId, orgId: payload.orgId },
      select: { id: true, hostname: true, sshUser: true, protocol: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    let script;
    if (payload.mode === 'posture') {
      // Posture v1 is explicitly Linux/systemd-only (docs/posture/posture-spec.md
      // §1). Nothing to install here — skip minting a token/CA lookup
      // entirely, since neither would ever be used.
      script = `# Shellius posture-only install — Windows
Write-Host "[shellius] Posture is not yet supported on Windows hosts (v1 is Linux/systemd-only)."
Write-Host "[shellius] Nothing to install for ${shEscape(server.hostname)}."
exit 0
`;
    } else {
      const caPubKey = await caService.getPublicKey(payload.orgId);
      const agentToken = await mintAgentToken(server.id);
      const apiUrl = getPublicBaseUrl(req);
      script = buildWindowsInstallScript({
        apiUrl,
        agentToken,
        caPubKey: caPubKey.trim(),
        hostname: server.hostname,
        protocol: server.protocol,
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  })
);

// ---------------------------------------------------------------------------
// POST /api/bootstrap/uninstall-token — authenticated; mirrors /token
// Returns a JWT bound to (serverId, orgId, kind:'uninstall') and the
// copy/paste one-liners for each platform.
// ---------------------------------------------------------------------------

const UNINSTALL_TTL_SECONDS = 30 * 60;

function signUninstallToken({ serverId, orgId, mode }) {
  return jwt.sign(
    { kind: 'uninstall', serverId, orgId, mode: mode || 'full', jti: crypto.randomUUID() },
    config.jwt.secret,
    { expiresIn: UNINSTALL_TTL_SECONDS }
  );
}

function verifyUninstallToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  if (payload.kind !== 'uninstall') throw new Error('Invalid token kind');
  // Same normalization as verifyBootstrapToken — see INSTALL_MODES.
  payload.mode = INSTALL_MODES.includes(payload.mode) ? payload.mode : 'full';
  return payload;
}

router.post(
  '/uninstall-token',
  authenticate,
  tenant,
  requirePermission('servers.onboard'),
  audit('bootstrap.uninstall_link.created', 'Server'),
  asyncHandler(async (req, res) => {
    const { error, value } = tokenSchema.validate(req.body);
    if (error) throw new ApiError(400, error.message);

    // Scoped for the same reason the install mint is: this returns a working
    // uninstall command for that host (docs/rbac/customer-scope-spec.md §4.2).
    const server = await prisma.server.findFirst({
      where: { id: value.serverId, orgId: req.orgId, ...serverScopeWhere(req.scope) },
      select: { id: true, hostname: true, protocol: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    const token = signUninstallToken({ serverId: server.id, orgId: req.orgId, mode: value.mode });
    const base = getPublicBaseUrl(req);
    const shUrl = `${base}/api/bootstrap/uninstall.sh?token=${token}`;

    const commands = {
      linux: `curl -fsSL "${shUrl}" | sudo bash`,
      macos: `curl -fsSL "${shUrl}" | sudo bash`,
    };

    res.json({
      success: true,
      data: {
        server: { id: server.id, hostname: server.hostname, protocol: server.protocol },
        mode: value.mode,
        expiresInSeconds: UNINSTALL_TTL_SECONDS,
        commands,
        urls: { sh: shUrl },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/bootstrap/uninstall.sh — public, token-gated
// ---------------------------------------------------------------------------

router.get(
  '/uninstall.sh',
  asyncHandler(async (req, res) => {
    const token = req.query.token;
    if (!token) throw new ApiError(400, 'Missing token');

    let payload;
    try {
      payload = verifyUninstallToken(token);
    } catch {
      throw new ApiError(401, 'Invalid or expired uninstall token');
    }
    await consumeOneTimeToken(payload);

    const server = await prisma.server.findFirst({
      where: { id: payload.serverId, orgId: payload.orgId },
      select: { hostname: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    const script =
      payload.mode === 'posture'
        ? buildPostureOnlyUninstallScript({ hostname: server.hostname })
        : buildUnixUninstallScript({ hostname: server.hostname, mode: payload.mode });

    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  })
);

// ---------------------------------------------------------------------------
// Script generators
// ---------------------------------------------------------------------------

function shEscape(value) {
  // Safe for single-quoted heredoc delimiters — we avoid embedding user input
  // into shell strings directly. Only used for predictable identifiers.
  return String(value).replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Steps 10-11 of the Unix install script: the posture collector. Extracted so
// mode 'ssh' can omit them entirely (docs/posture/posture-spec.md §4). It is a
// template literal fragment, interpolated into buildUnixInstallScript's script
// body — the `\$` escapes below are shell variables, not JS ones.
// ---------------------------------------------------------------------------
const POSTURE_STEPS_TEMPLATE = `# ---------------------------------------------------------------------------
# 10. Posture collector + report wrapper scripts
#
# Runs on EVERY invocation, full install AND --upgrade — same rule as the
# heartbeat timer in step 8, so a re-provisioned host always picks up the
# current collector with no extra step (docs/posture/posture-spec.md §1
# decision 4, §4). A missing/broken posture collector must never fail
# bootstrap: SSH trust (steps 1-6) is the only thing this script is not
# allowed to compromise, so every failure path below is a warning, not an
# abort.
# ---------------------------------------------------------------------------
echo "[shellius] [10/14] Installing posture collector scripts"
if [ -n "\$POSTURE_COLLECT_B64" ] && [ -n "\$POSTURE_REPORT_B64" ]; then
  install -d -m 755 /usr/local/sbin
  echo "\$POSTURE_COLLECT_B64" | base64 -d > "\$POSTURE_COLLECT_PATH"
  chmod 755 "\$POSTURE_COLLECT_PATH"
  chown root:0 "\$POSTURE_COLLECT_PATH" 2>/dev/null || chown root:wheel "\$POSTURE_COLLECT_PATH" 2>/dev/null || true
  echo "\$POSTURE_REPORT_B64" | base64 -d > "\$POSTURE_REPORT_PATH"
  chmod 755 "\$POSTURE_REPORT_PATH"
  chown root:0 "\$POSTURE_REPORT_PATH" 2>/dev/null || chown root:wheel "\$POSTURE_REPORT_PATH" 2>/dev/null || true
  echo "[shellius]   Installed \$POSTURE_COLLECT_PATH and \$POSTURE_REPORT_PATH"
else
  echo "[shellius]   ! Posture collector assets missing from this deployment image — skipping (SSH trust is unaffected)"
fi

# ---------------------------------------------------------------------------
# 11. Posture systemd unit/timer + narrow sudoers drop-in (Linux only)
#
# Deliberately a SEPARATE unit and timer from shellius-heartbeat and
# shellius-jit-reap — a crashing or OOMing collector must never be able to
# affect SSH authentication. Runs as its own unprivileged system account
# ('shellius-posture'), never root, never in the 'docker' group, no Docker
# socket access — root-only reads go through the narrow sudoers grant
# below for exactly: ss, ufw status, firewall-cmd --list-all, systemctl
# show, iptables -t nat -S, nft list table ip nat. See
# scripts/posture/shellius-posture.sudoers for the source of truth and
# docs/posture/posture-spec.md §1 decision 2, §4.
# ---------------------------------------------------------------------------
echo "[shellius] [11/14] Installing posture systemd unit/timer + sudoers"
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1 \\
   && [ -n "\$POSTURE_SERVICE_B64" ] && [ -n "\$POSTURE_TIMER_B64" ] && [ -n "\$POSTURE_SUDOERS_B64" ]; then
  # Dedicated, unprivileged, login-less system account — isolated from
  # 'nobody' (used by check-principals) so the two agents' privilege grants
  # never overlap or compound.
  if ! id -u "\$POSTURE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "\$POSTURE_USER" 2>/dev/null \\
      || useradd -r -M -s /usr/sbin/nologin "\$POSTURE_USER" 2>/dev/null \\
      || echo "[shellius]   ! could not create \$POSTURE_USER user — posture collector will not run"
  fi

  if id -u "\$POSTURE_USER" >/dev/null 2>&1; then
    echo "\$POSTURE_SUDOERS_B64" | base64 -d > /etc/sudoers.d/shellius-posture
    chmod 0440 /etc/sudoers.d/shellius-posture
    chown root:0 /etc/sudoers.d/shellius-posture 2>/dev/null || true
    if command -v visudo >/dev/null 2>&1; then
      if ! visudo -c -f /etc/sudoers.d/shellius-posture >/dev/null 2>&1; then
        echo "[shellius]   ! posture sudoers validation failed — removing bad drop-in" >&2
        rm -f /etc/sudoers.d/shellius-posture
      fi
    fi

    if [ "\$CONTAINER_SCAN" = "1" ] && [ -n "\$POSTURE_CONTAINER_SUDOERS_B64" ]; then
      echo "\$POSTURE_CONTAINER_SUDOERS_B64" | base64 -d > /etc/sudoers.d/shellius-posture-containers
      chmod 0440 /etc/sudoers.d/shellius-posture-containers
      chown root:0 /etc/sudoers.d/shellius-posture-containers 2>/dev/null || true
      if command -v visudo >/dev/null 2>&1; then
        if visudo -c -f /etc/sudoers.d/shellius-posture-containers >/dev/null 2>&1; then
          echo "[shellius]   Container state scan ENABLED (stopped containers will be reported)"
        else
          echo "[shellius]   ! container sudoers validation failed — removing bad drop-in" >&2
          rm -f /etc/sudoers.d/shellius-posture-containers
        fi
      fi
    elif [ "\$CONTAINER_SCAN" = "0" ]; then
      rm -f /etc/sudoers.d/shellius-posture-containers
      echo "[shellius]   Container state scan disabled"
    fi

    echo "\$POSTURE_SERVICE_B64" | base64 -d > /etc/systemd/system/shellius-posture.service
    echo "\$POSTURE_TIMER_B64" | base64 -d > /etc/systemd/system/shellius-posture.timer
    chmod 644 /etc/systemd/system/shellius-posture.service /etc/systemd/system/shellius-posture.timer

    systemctl daemon-reload 2>/dev/null || true
    systemctl enable --now shellius-posture.timer 2>/dev/null \\
      && echo "[shellius]   Posture collector timer enabled (shellius-posture.timer, every 5 min)" \\
      || echo "[shellius]   ! could not enable shellius-posture.timer"
  fi
else
  echo "[shellius]   Skipping posture systemd units (not Linux, no systemd, or assets missing)"
fi
`;

// The self-test's posture checks (12h). Skipped in mode 'ssh' so the script
// doesn't hunt for a collector it was never asked to install, and doesn't
// claim one is running in its closing summary.
const POSTURE_SELFTEST_TEMPLATE = `# 12h. Posture collector checks — NEVER SELF_TEST_FAIL=1 for any of these.
# A degraded or absent posture collector is a reported gap in the Shellius
# UI, never a reason to fail bootstrap or touch the exit code that SSH
# trust's own checks (12a-12d) rely on.
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  if [ -z "\$POSTURE_SERVICE_B64" ]; then
    echo "[shellius]   ! posture collector assets not present in this deployment image — see docs/posture/posture-spec.md"
  elif systemctl is-enabled shellius-posture.timer >/dev/null 2>&1; then
    echo "[shellius]   [OK] shellius-posture.timer is enabled"
  else
    echo "[shellius]   ! shellius-posture.timer not enabled — run: systemctl enable --now shellius-posture.timer"
  fi
fi
if [ -x "\$POSTURE_COLLECT_PATH" ]; then
  echo "[shellius]   [OK] posture collector is executable"
fi
if command -v sudo >/dev/null 2>&1 && id -u "\$POSTURE_USER" >/dev/null 2>&1; then
  if sudo -n -u "\$POSTURE_USER" sudo -n -l >/dev/null 2>&1; then
    echo "[shellius]   [OK] \$POSTURE_USER has an active sudoers grant"
  else
    echo "[shellius]   ! could not confirm \$POSTURE_USER's sudoers grant (non-fatal — checked as root, not as \$POSTURE_USER)"
  fi
fi`;

function buildUnixInstallScript({ apiUrl, agentToken, caPubKey, hostname, sshUser, serverId, orgId, mode = 'full' }) {
  // mode 'ssh' is 'full' minus the posture collector: the SSH-trust steps are
  // identical, steps 10-11 are omitted entirely, and the remaining steps are
  // renumbered so the operator doesn't watch "[12/14]" go by in a 12-step run.
  const withPosture = mode !== 'ssh';
  const TOTAL = withPosture ? 14 : 12;
  const STEP_VALIDATE = withPosture ? 12 : 10;
  const STEP_RELOAD = withPosture ? 13 : 11;
  const STEP_SELFTEST = withPosture ? 14 : 12;
  const POSTURE_INSTALL_BLOCK = withPosture ? POSTURE_STEPS_TEMPLATE : '';
  const POSTURE_SELFTEST_BLOCK = withPosture ? POSTURE_SELFTEST_TEMPLATE : '';
  const POSTURE_SUMMARY_BLOCK = withPosture
    ? 'if [ -n "\\$POSTURE_SERVICE_B64" ] && [ "$PLATFORM" = "linux" ]; then\n  echo "[shellius]   Posture collector: shellius-posture.timer (every 5 min, user \\$POSTURE_USER)"\nfi'
    : '';
  // Notes for maintainers:
  // - Avoid heredocs where possible — paste-mangling has bitten us before.
  //   We use printf streams (one printf per line) for every file write so the
  //   only delimiters in the script are the JS template literal backticks.
  // - This script is fully idempotent and self-healing: re-run it any time.
  //   Every step also re-applies perms even if files exist, so directory-mode
  //   drift from earlier installs is fixed automatically.
  // - At the end the script runs an inline self-test that exits non-zero if
  //   sshd's effective config is wrong, the token isn't readable by 'nobody',
  //   or check-principals can't run. No silent dead config.
  // - Phase 21B: check-principals v2 adds JIT user provisioning from the
  //   manifest field in /api/certificates/verify responses. Existing hosts
  //   running the old script keep working — they just ignore the manifest.
  //   Use --upgrade to re-install only the agent components on an already-
  //   bootstrapped host without touching CA trust.
  // - Posture collector (steps 10-11): unlike CA trust / check-principals,
  //   the collector/report scripts, systemd units and sudoers drop-in are
  //   read from scripts/posture/ (see POSTURE_ASSETS above) and shipped as
  //   base64 blobs, same technique as CA_PUB_B64/AGENT_SECRET_B64 below —
  //   NOT the printf-per-line technique step 4 uses for check-principals.
  //   Reason: printf-per-line silently drops a trailing '\' wherever the
  //   literal sequence "\'" appears (JS template-literal escaping consumes
  //   it), which breaks any embedded script that uses bash line-continuation
  //   — as the check-principals block above already does, invisibly. Static
  //   file + base64 sidesteps that class of bug entirely and keeps the
  //   collector lintable on its own (bash -n / shellcheck / visudo -c /
  //   systemd-analyze verify — see scripts/posture/).
  const postureReportScript = POSTURE_ASSETS.report
    ? POSTURE_ASSETS.report.replace('__SHELLIUS_POSTURE_API_URL__', apiUrl)
    : null;
  const postureCollectB64 = POSTURE_ASSETS.collect
    ? Buffer.from(POSTURE_ASSETS.collect, 'utf8').toString('base64')
    : '';
  const postureReportB64 = postureReportScript
    ? Buffer.from(postureReportScript, 'utf8').toString('base64')
    : '';
  const postureServiceB64 = POSTURE_ASSETS.service
    ? Buffer.from(POSTURE_ASSETS.service, 'utf8').toString('base64')
    : '';
  const postureTimerB64 = POSTURE_ASSETS.timer
    ? Buffer.from(POSTURE_ASSETS.timer, 'utf8').toString('base64')
    : '';
  const postureSudoersB64 = POSTURE_ASSETS.sudoers
    ? Buffer.from(POSTURE_ASSETS.sudoers, 'utf8').toString('base64')
    : '';
  const postureContainerSudoersB64 = POSTURE_ASSETS.containerSudoers
    ? Buffer.from(POSTURE_ASSETS.containerSudoers, 'utf8').toString('base64')
    : '';

  return `#!/usr/bin/env bash
# Shellius host bootstrap v2 — installs CA trust, check-principals agent,
# JIT reaper timer, and narrow sudoers rules for JIT provisioning.
# Target host: ${hostname}
# Idempotent: safe to re-run. Self-tests at the end and exits non-zero if
# anything is misconfigured.
#
# Usage:
#   sudo bash install.sh            — full install (CA + all agent components)
#   sudo bash install.sh --upgrade  — re-install agent components only
#                                     (skips CA key + sshd config rewrite)
#
#   --with-container-scan  also let the posture collector see STOPPED
#                          containers (narrow sudoers grant for 'docker ps
#                          -a' / 'podman ps -a' and a fixed-format inspect
#                          of published ports only — never the docker
#                          group, never the socket).
#   --no-container-scan    remove that grant. Neither flag leaves whatever
#                          is already installed untouched.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

UPGRADE_ONLY=0
# Off by default. 'ss' cannot see a stopped container, so its published port
# and its firewall rule look like an abandoned rule rather than a service one
# 'docker start' away from being reachable. Closing that blind spot needs a
# root-level read of the container list, so it is the operator's call per
# host — see scripts/posture/shellius-posture-containers.sudoers for exactly
# what the grant does and does not allow.
CONTAINER_SCAN=""
for arg in "\$@"; do
  [ "\$arg" = "--upgrade" ] && UPGRADE_ONLY=1
  [ "\$arg" = "--with-container-scan" ] && CONTAINER_SCAN=1
  [ "\$arg" = "--no-container-scan" ] && CONTAINER_SCAN=0
done

# ---------------------------------------------------------------------------
# Detect platform
# ---------------------------------------------------------------------------
UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) echo "ERROR: unsupported platform: $UNAME_S" >&2; exit 1 ;;
esac
echo "[shellius] Detected platform: $PLATFORM"
[ "\$UPGRADE_ONLY" = "1" ] && echo "[shellius] Mode: --upgrade (skipping CA trust + sshd config)"

SSH_DIR=/etc/ssh
CA_PUB_PATH="$SSH_DIR/shellius_ca.pub"
AGENT_DIR=/etc/shellius
AGENT_TOKEN_PATH="$AGENT_DIR/agent-token"
CHECK_PRINCIPALS_PATH=/usr/local/sbin/shellius-check-principals
SSHD_CONFIG="$SSH_DIR/sshd_config"
SSHD_DROPIN="$SSH_DIR/sshd_config.d/99-shellius.conf"
JIT_DIR=/var/lib/shellius/jit
JIT_LOG=/var/log/shellius-jit.log

# Encoded payloads — base64 to bypass heredoc/quoting hazards entirely.
CA_PUB_B64='${Buffer.from(caPubKey + '\n', 'utf8').toString('base64')}'
AGENT_SECRET_B64='${Buffer.from(agentToken + '\n', 'utf8').toString('base64')}'

# Posture collector artifacts (empty string if this deployment's image is
# missing scripts/posture/ — steps 10-11 detect that and skip, they never
# fail the run). See docs/posture/posture-spec.md §4.
POSTURE_COLLECT_B64='${postureCollectB64}'
POSTURE_REPORT_B64='${postureReportB64}'
POSTURE_SERVICE_B64='${postureServiceB64}'
POSTURE_TIMER_B64='${postureTimerB64}'
POSTURE_SUDOERS_B64='${postureSudoersB64}'
POSTURE_CONTAINER_SUDOERS_B64='${postureContainerSudoersB64}'
POSTURE_USER=shellius-posture
POSTURE_COLLECT_PATH=/usr/local/sbin/shellius-posture-collect
POSTURE_REPORT_PATH=/usr/local/sbin/shellius-posture-report

# ---------------------------------------------------------------------------
# 0. Prerequisites — jq and acl tools (Linux only; skip on macOS)
# ---------------------------------------------------------------------------
if [ "$PLATFORM" = "linux" ] && [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [0/${TOTAL}] Installing prerequisites (jq, acl)"
  # Skip if already installed — idempotent, and avoids slow apt refresh on
  # hosts that already have what we need.
  if command -v jq >/dev/null 2>&1 && command -v setfacl >/dev/null 2>&1; then
    echo "[shellius]   [OK] jq and setfacl already installed — skipping package manager"
  elif command -v apt-get >/dev/null 2>&1; then
    # Non-interactive + force-keep existing confs so we never hang on a
    # debconf prompt when stdin is an HTTP pipe (curl | sudo bash).
    export DEBIAN_FRONTEND=noninteractive
    export NEEDRESTART_MODE=a
    export NEEDRESTART_SUSPEND=1
    echo "[shellius]   • apt-get update"
    apt-get update -qq -o Dpkg::Use-Pty=0 || true
    echo "[shellius]   • apt-get install jq acl"
    apt-get install -y -qq \\
      -o Dpkg::Use-Pty=0 \\
      -o Dpkg::Options::=--force-confdef \\
      -o Dpkg::Options::=--force-confold \\
      jq acl < /dev/null || {
        echo "[shellius]   ! apt-get install failed — ensure jq and setfacl are available manually."
      }
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q jq acl < /dev/null || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q jq acl < /dev/null || true
  else
    echo "[shellius]   ! No supported package manager found — ensure jq and setfacl are installed manually."
  fi
  # Sanity check — both tools must be present to proceed.
  if ! command -v jq >/dev/null 2>&1; then
    echo "[shellius]   [FAIL] jq is not installed; aborting." >&2
    exit 1
  fi
  if ! command -v setfacl >/dev/null 2>&1; then
    echo "[shellius]   ! setfacl not installed — JIT ACL read paths will be skipped."
  fi
fi

# ---------------------------------------------------------------------------
# 1. CA public key
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [1/${TOTAL}] Writing CA public key → $CA_PUB_PATH"
  install -d -m 755 "$SSH_DIR"
  echo "$CA_PUB_B64" | base64 -d > "$CA_PUB_PATH"
  chmod 644 "$CA_PUB_PATH"
  chown root:0 "$CA_PUB_PATH" 2>/dev/null || chown root:wheel "$CA_PUB_PATH" 2>/dev/null || true
else
  echo "[shellius] [1/${TOTAL}] Skipping CA public key (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 2. Agent token + directory perms
#
# Unlike CA trust (step 1), this step ALWAYS runs — including on --upgrade —
# because --upgrade is precisely how a per-host token gets minted/rotated for
# a host that was bootstrapped before this change (or whose token needs
# rotating). Every script generation (GET /api/bootstrap/install.sh) mints a
# fresh token server-side and overwrites Server.agentTokenHash, so the value
# baked into THIS script invalidates whatever token was written here before.
# ---------------------------------------------------------------------------
echo "[shellius] [2/${TOTAL}] Writing agent token → $AGENT_TOKEN_PATH"
install -d "$AGENT_DIR"
# Force mode 755 even if the directory existed from an earlier run.
# 'install -d -m 755' only applies the mode on creation; a previously-created
# 750 directory would silently block 'nobody' from chdir-ing in.
chmod 755 "$AGENT_DIR"
chown root:0 "$AGENT_DIR" 2>/dev/null || chown root:wheel "$AGENT_DIR" 2>/dev/null || true
echo "$AGENT_SECRET_B64" | base64 -d > "$AGENT_TOKEN_PATH"
# sshd's AuthorizedPrincipalsCommand MUST run as an unprivileged user
# ('nobody') per OpenSSH security policy, so check-principals — which reads
# this token to call /api/certificates/verify — must be able to read it too.
# We keep the file world-readable (644) rather than chasing a dedicated
# per-distro group for 'nobody': this token is per-host and read-only (cert
# verification + heartbeat), so a local read of it only lets an attacker who
# already has host-local access impersonate THIS host's agent — it can no
# longer authenticate against any OTHER host or org's certificates (that's
# the actual fix here; see certificateService.verify's host-binding check).
# world-readable is therefore an acceptable, bounded trade-off.
chmod 644 "$AGENT_TOKEN_PATH"
chown root:0 "$AGENT_TOKEN_PATH" 2>/dev/null || chown root:wheel "$AGENT_TOKEN_PATH" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. JIT working directories
# ---------------------------------------------------------------------------
echo "[shellius] [3/${TOTAL}] Creating JIT runtime directories"
install -d -m 750 /var/lib/shellius
install -d -m 750 "$JIT_DIR"
chown root:0 /var/lib/shellius 2>/dev/null || true
chown root:0 "$JIT_DIR" 2>/dev/null || true
touch "$JIT_LOG"
chmod 640 "$JIT_LOG"
chown root:adm "$JIT_LOG" 2>/dev/null || chown root:0 "$JIT_LOG" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. check-principals script (v2 — JIT provisioning)
# ---------------------------------------------------------------------------
echo "[shellius] [4/${TOTAL}] Installing check-principals v2 → $CHECK_PRINCIPALS_PATH"
install -d -m 755 /usr/local/sbin
# Build the check-principals script via printf — no heredocs.
# The script supports two subcommands:
#   validate <user> <serial>  — called by sshd; verifies cert + applies JIT manifest
#   reap                      — called by the systemd timer; cleans up expired leases
{
  printf '%s\\n' '#!/usr/bin/env bash'
  printf '%s\\n' '# Shellius check-principals v2 — sshd AuthorizedPrincipalsCommand + JIT reaper.'
  printf '%s\\n' '# Subcommands: validate <user> <serial>  |  reap'
  printf '%s\\n' '# Logs actions to /var/log/shellius-jit.log and syslog.'
  printf '%s\\n' 'set -euo pipefail'
  printf '%s\\n' ''
  printf '%s\\n' 'CMD="\${1:-validate}"'
  printf '%s\\n' 'TARGET_USER="\${2:-}"'
  printf '%s\\n' 'SERIAL="\${3:-}"'
  printf 'API_URL=%s\\n' "'${apiUrl}'"
  printf '%s\\n' 'TOKEN_FILE=/etc/shellius/agent-token'
  printf '%s\\n' 'JIT_DIR=/var/lib/shellius/jit'
  printf '%s\\n' 'JIT_LOG=/var/log/shellius-jit.log'
  printf '%s\\n' ''
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' '# Helpers'
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' 'jit_log() {'
  printf '%s\\n' '  local ts; ts="\$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u)"'
  printf '%s\\n' '  printf '"'"'%s %s\n'"'"' "\$ts" "\$1" >> "\$JIT_LOG" 2>/dev/null || true'
  printf '%s\\n' '  logger -t shellius-check-principals "\$1" 2>/dev/null || true'
  printf '%s\\n' '}'
  printf '%s\\n' ''
  printf '%s\\n' '# Run a command as root via sudo (needed when script runs as nobody)'
  printf '%s\\n' 'as_root() { sudo "\$@"; }'
  printf '%s\\n' ''
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' '# reap_expired_leases — scan JIT_DIR, clean up expired users with no sessions'
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' 'reap_expired_leases() {'
  printf '%s\\n' '  [ -d "\$JIT_DIR" ] || return 0'
  printf '%s\\n' '  local now; now="\$(date +%s)"'
  printf '%s\\n' '  for lease_file in "\$JIT_DIR"/*.lease; do'
  printf '%s\\n' '    [ -f "\$lease_file" ] || continue'
  printf '%s\\n' '    local linux_user expires_at hard_cutoff groups acl_paths'
  printf '%s\\n' '    linux_user="\$(jq -r .linuxUser "\$lease_file" 2>/dev/null)" || continue'
  printf '%s\\n' '    expires_at="\$(jq -r .expiresAt "\$lease_file" 2>/dev/null)" || continue'
  printf '%s\\n' '    hard_cutoff="\$(jq -r .hardCutoff "\$lease_file" 2>/dev/null)" || continue'
  printf '%s\\n' '    [ -n "\$linux_user" ] || continue'
  printf '%s\\n' '    [ -n "\$expires_at" ] || continue'
  printf '%s\\n' '    local exp_epoch'
  printf '%s\\n' '    exp_epoch="\$(date -d "\$expires_at" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%SZ" "\$expires_at" +%s 2>/dev/null || echo 0)"'
  printf '%s\\n' '    [ "\$now" -ge "\$exp_epoch" ] || continue'
  printf '%s\\n' '    # Lease is expired — check for active sessions'
  printf '%s\\n' '    local has_session=0'
  printf '%s\\n' '    if as_root loginctl show-user "\$linux_user" >/dev/null 2>&1; then'
  printf '%s\\n' '      local state'
  printf '%s\\n' '      state="\$(as_root loginctl show-user "\$linux_user" -p State --value 2>/dev/null || echo unknown)"'
  printf '%s\\n' '      [ "\$state" = "active" ] || [ "\$state" = "lingering" ] && has_session=1 || true'
  printf '%s\\n' '    fi'
  printf '%s\\n' '    if [ "\$has_session" = "1" ] && [ "\$hard_cutoff" != "true" ]; then'
  printf '%s\\n' '      jit_log "REAP_SKIP linuxUser=\$linux_user reason=active_session"'
  printf '%s\\n' '      continue'
  printf '%s\\n' '    fi'
  printf '%s\\n' '    if [ "\$has_session" = "1" ] && [ "\$hard_cutoff" = "true" ]; then'
  printf '%s\\n' '      jit_log "REAP_KILL linuxUser=\$linux_user reason=hardCutoff"'
  printf '%s\\n' '      as_root loginctl kill-user "\$linux_user" 2>/dev/null || true'
  printf '%s\\n' '      sleep 1'
  printf '%s\\n' '    fi'
  printf '%s\\n' '    # Strip ACLs before removing user'
  printf '%s\\n' '    acl_paths="\$(jq -r '"'"'.aclReadPaths[]? // empty'"'"' "\$lease_file" 2>/dev/null || true)"'
  printf '%s\\n' '    if [ -n "\$acl_paths" ] && command -v setfacl >/dev/null 2>&1; then'
  printf '%s\\n' '      while IFS= read -r apath; do'
  printf '%s\\n' '        [ -e "\$apath" ] || continue'
  printf '%s\\n' '        as_root setfacl -R -x "u:\$linux_user" "\$apath" 2>/dev/null || true'
  printf '%s\\n' '      done <<< "\$acl_paths"'
  printf '%s\\n' '    fi'
  printf '%s\\n' '    # Remove sudoers drop-in'
  printf '%s\\n' '    local sudoers_file="/etc/sudoers.d/shellius-\${linux_user}"'
  printf '%s\\n' '    [ -f "\$sudoers_file" ] && as_root rm -f "\$sudoers_file" && jit_log "REAP_SUDOERS linuxUser=\$linux_user" || true'
  printf '%s\\n' '    # Delete user and home directory'
  printf '%s\\n' '    if id -u "\$linux_user" >/dev/null 2>&1; then'
  printf '%s\\n' '      as_root userdel -r "\$linux_user" 2>/dev/null || as_root userdel "\$linux_user" 2>/dev/null || true'
  printf '%s\\n' '      jit_log "REAP_USER linuxUser=\$linux_user"'
  printf '%s\\n' '    fi'
  printf '%s\\n' '    rm -f "\$lease_file"'
  printf '%s\\n' '    jit_log "REAP_DONE linuxUser=\$linux_user"'
  printf '%s\\n' '  done'
  printf '%s\\n' '}'
  printf '%s\\n' ''
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' '# apply_manifest — idempotent JIT provisioning from the verify response'
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' 'apply_manifest() {'
  printf '%s\\n' '  local manifest="$1"'
  printf '%s\\n' '  local linux_user uid groups sudo_flag acl_paths acl_recursive hard_cutoff lease_id ttl_seconds'
  printf '%s\\n' '  linux_user="\$(echo "\$manifest" | jq -r '"'"'.linuxUser // empty'"'"')" || return 1'
  printf '%s\\n' '  [ -n "\$linux_user" ] || return 0'
  printf '%s\\n' '  uid="\$(echo "\$manifest" | jq -r '"'"'.uid // empty'"'"')" || return 1'
  printf '%s\\n' '  groups="\$(echo "\$manifest" | jq -r '"'"'[.groups[]? // empty] | join(",")'"'"')" || return 1'
  printf '%s\\n' '  sudo_flag="\$(echo "\$manifest" | jq -r '"'"'.sudo // false'"'"')" || return 1'
  printf '%s\\n' '  acl_recursive="\$(echo "\$manifest" | jq -r '"'"'.aclRecursive // false'"'"')" || return 1'
  printf '%s\\n' '  hard_cutoff="\$(echo "\$manifest" | jq -r '"'"'.hardCutoff // false'"'"')" || return 1'
  printf '%s\\n' '  lease_id="\$(echo "\$manifest" | jq -r '"'"'.leaseId // empty'"'"')" || return 1'
  printf '%s\\n' '  ttl_seconds="\$(echo "\$manifest" | jq -r '"'"'.ttlSeconds // 3600'"'"')" || return 1'
  printf '%s\\n' '  acl_paths="\$(echo "\$manifest" | jq -r '"'"'.aclReadPaths[]? // empty'"'"')" || return 1'
  printf '%s\\n' ''
  printf '%s\\n' '  # 1. Create user if missing (idempotent)'
  printf '%s\\n' '  if ! id -u "\$linux_user" >/dev/null 2>&1; then'
  printf '%s\\n' '    local useradd_args=(-m -s /bin/bash)'
  printf '%s\\n' '    [ -n "\$uid" ] && useradd_args+=(-u "\$uid") || true'
  printf '%s\\n' '    as_root useradd "\${useradd_args[@]}" "\$linux_user"'
  printf '%s\\n' '    jit_log "JIT_USERADD linuxUser=\$linux_user uid=\$uid"'
  printf '%s\\n' '  fi'
  printf '%s\\n' ''
  printf '%s\\n' '  # 2. Converge group membership'
  printf '%s\\n' '  if [ -n "\$groups" ]; then'
  printf '%s\\n' '    # Add to all specified groups'
  printf '%s\\n' '    local IFS_OLD="\$IFS"'
  printf '%s\\n' '    IFS=","'
  printf '%s\\n' '    for grp in \$groups; do'
  printf '%s\\n' '      [ -n "\$grp" ] || continue'
  printf '%s\\n' '      if getent group "\$grp" >/dev/null 2>&1; then'
  printf '%s\\n' '        as_root usermod -aG "\$grp" "\$linux_user" 2>/dev/null || true'
  printf '%s\\n' '      else'
  printf '%s\\n' '        jit_log "JIT_WARN group=\$grp not found on host, skipping"'
  printf '%s\\n' '      fi'
  printf '%s\\n' '    done'
  printf '%s\\n' '    IFS="\$IFS_OLD"'
  printf '%s\\n' '  fi'
  printf '%s\\n' ''
  printf '%s\\n' '  # 3. Sudoers drop-in — present iff sudo_flag === true'
  printf '%s\\n' '  local sudoers_file="/etc/sudoers.d/shellius-\${linux_user}"'
  printf '%s\\n' '  if [ "\$sudo_flag" = "true" ]; then'
  printf '%s\\n' '    printf '"'"'%s ALL=(ALL) NOPASSWD: ALL\n'"'"' "\$linux_user" | as_root tee "\$sudoers_file" >/dev/null'
  printf '%s\\n' '    as_root chmod 0440 "\$sudoers_file"'
  printf '%s\\n' '    jit_log "JIT_SUDOERS linuxUser=\$linux_user enabled=true"'
  printf '%s\\n' '  else'
  printf '%s\\n' '    [ -f "\$sudoers_file" ] && as_root rm -f "\$sudoers_file" && jit_log "JIT_SUDOERS linuxUser=\$linux_user enabled=false removed" || true'
  printf '%s\\n' '  fi'
  printf '%s\\n' ''
  printf '%s\\n' '  # 4. ACL read paths'
  printf '%s\\n' '  if [ -n "\$acl_paths" ] && command -v setfacl >/dev/null 2>&1; then'
  printf '%s\\n' '    local acl_flag="-m"'
  printf '%s\\n' '    [ "\$acl_recursive" = "true" ] && acl_flag="-Rm" || true'
  printf '%s\\n' '    while IFS= read -r apath; do'
  printf '%s\\n' '      [ -n "\$apath" ] || continue'
  printf '%s\\n' '      if [ -e "\$apath" ]; then'
  printf '%s\\n' '        as_root setfacl "\$acl_flag" "u:\$linux_user:rX" "\$apath" 2>/dev/null || true'
  printf '%s\\n' '        jit_log "JIT_ACL linuxUser=\$linux_user path=\$apath recursive=\$acl_recursive"'
  printf '%s\\n' '      else'
  printf '%s\\n' '        jit_log "JIT_WARN aclPath=\$apath not found, skipping"'
  printf '%s\\n' '      fi'
  printf '%s\\n' '    done <<< "\$acl_paths"'
  printf '%s\\n' '  fi'
  printf '%s\\n' ''
  printf '%s\\n' '  # 5. Write lease file'
  printf '%s\\n' '  local expires_at; expires_at="\$(date -u -d "+\${ttl_seconds} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v +\${ttl_seconds}S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"'
  printf '%s\\n' '  local lease_file="\$JIT_DIR/\${linux_user}.lease"'
  printf '%s\\n' '  printf '"'"'{"linuxUser":"%s","uid":"%s","leaseId":"%s","expiresAt":"%s","groups":%s,"sudo":%s,"aclReadPaths":%s,"aclRecursive":%s,"hardCutoff":%s}\n'"'"' \'
  printf '%s\\n' '    "\$linux_user" "\$uid" "\$lease_id" "\$expires_at" \'
  printf '%s\\n' '    "\$(echo "\$manifest" | jq -c '"'"'.groups // []'"'"')" \'
  printf '%s\\n' '    "\$sudo_flag" \'
  printf '%s\\n' '    "\$(echo "\$manifest" | jq -c '"'"'.aclReadPaths // []'"'"')" \'
  printf '%s\\n' '    "\$acl_recursive" "\$hard_cutoff" > "\$lease_file"'
  printf '%s\\n' '  chmod 640 "\$lease_file"'
  printf '%s\\n' '  jit_log "JIT_LEASE linuxUser=\$linux_user leaseId=\$lease_id expiresAt=\$expires_at"'
  printf '%s\\n' '}'
  printf '%s\\n' ''
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' '# reap subcommand — timer-driven cleanup, no verify call'
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' 'if [ "\$CMD" = "reap" ]; then'
  printf '%s\\n' '  jit_log "REAP_START"'
  printf '%s\\n' '  reap_expired_leases'
  printf '%s\\n' '  jit_log "REAP_END"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' ''
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' '# validate subcommand (default) — called by sshd for every connection'
  printf '%s\\n' '# ---------------------------------------------------------------------------'
  printf '%s\\n' ''
  printf '%s\\n' '# First: opportunistic reap of expired leases (free on busy hosts)'
  printf '%s\\n' 'reap_expired_leases 2>/dev/null || true'
  printf '%s\\n' ''
  printf '%s\\n' 'if [ ! -r "\$TOKEN_FILE" ]; then'
  printf '%s\\n' '  jit_log "FAIL token file unreadable as \$(id -un): \$TOKEN_FILE"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' 'TOKEN="\$(cat "\$TOKEN_FILE")"'
  printf '%s\\n' 'if [ -z "\$TOKEN" ]; then jit_log "FAIL token file empty"; exit 0; fi'
  printf '%s\\n' ''
  printf '%s\\n' 'BODY="{\\"serial\\":\\"\$SERIAL\\",\\"principal\\":\\"\$TARGET_USER\\"}"'
  printf '%s\\n' 'RESP="\$(curl -fsS --max-time 5 -H "x-agent-token: \$TOKEN" -H "Content-Type: application/json" -d "\$BODY" "\$API_URL/api/certificates/verify" 2>&1 || echo "CURL_ERROR:\$?")"'
  printf '%s\\n' 'if echo "\$RESP" | grep -q "^CURL_ERROR"; then'
  printf '%s\\n' '  jit_log "FAIL curl to \$API_URL: \$RESP"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' ''
  printf '%s\\n' 'if ! echo "\$RESP" | jq -e .data.valid >/dev/null 2>&1 && echo "\$RESP" | grep -q "\\"success\\":true"; then'
  printf '%s\\n' '  # Old-style response (pre-21A) — no jq parsing needed'
  printf '%s\\n' '  jit_log "OK_LEGACY user=\$TARGET_USER serial=\$SERIAL"'
  printf '%s\\n' '  echo "\$TARGET_USER"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' ''
  printf '%s\\n' 'VALID="\$(echo "\$RESP" | jq -r '"'"'.data.valid // false'"'"' 2>/dev/null || echo false)"'
  printf '%s\\n' 'if [ "\$VALID" != "true" ]; then'
  printf '%s\\n' '  jit_log "DENY user=\$TARGET_USER serial=\$SERIAL resp=\$(echo "\$RESP" | head -c 200)"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' ''
  printf '%s\\n' '# Extract principals from response (array of strings)'
  printf '%s\\n' 'PRINCIPALS="\$(echo "\$RESP" | jq -r '"'"'.data.principals[]? // empty'"'"' 2>/dev/null || echo "\$TARGET_USER")"'
  printf '%s\\n' '[ -n "\$PRINCIPALS" ] || PRINCIPALS="\$TARGET_USER"'
  printf '%s\\n' ''
  printf '%s\\n' '# Apply JIT manifest if present'
  printf '%s\\n' 'MANIFEST="\$(echo "\$RESP" | jq -c '"'"'.data.manifest // empty'"'"' 2>/dev/null || true)"'
  printf '%s\\n' 'if [ -n "\$MANIFEST" ] && [ "\$MANIFEST" != "null" ] && [ "\$MANIFEST" != "empty" ]; then'
  printf '%s\\n' '  jit_log "JIT_START user=\$TARGET_USER serial=\$SERIAL"'
  printf '%s\\n' '  if ! apply_manifest "\$MANIFEST"; then'
  printf '%s\\n' '    jit_log "JIT_FAIL user=\$TARGET_USER — provisioning error, rejecting connection"'
  printf '%s\\n' '    exit 1'
  printf '%s\\n' '  fi'
  printf '%s\\n' '  jit_log "JIT_OK user=\$TARGET_USER serial=\$SERIAL"'
  printf '%s\\n' 'fi'
  printf '%s\\n' ''
  printf '%s\\n' '# Emit one principal per line for sshd'
  printf '%s\\n' 'echo "\$PRINCIPALS"'
  printf '%s\\n' 'jit_log "OK user=\$TARGET_USER serial=\$SERIAL"'
  printf '%s\\n' 'exit 0'
} > "$CHECK_PRINCIPALS_PATH"
chmod 755 "$CHECK_PRINCIPALS_PATH"
chown root:0 "$CHECK_PRINCIPALS_PATH" 2>/dev/null || chown root:wheel "$CHECK_PRINCIPALS_PATH" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Narrow sudoers for check-principals (run as nobody but needs root ops)
# ---------------------------------------------------------------------------
echo "[shellius] [5/${TOTAL}] Installing narrow sudoers drop-in for check-principals"
{
  printf '%s\\n' '# Managed by Shellius bootstrap — DO NOT EDIT MANUALLY'
  printf '%s\\n' '# Grants nobody (sshd AuthorizedPrincipalsCommandUser) the exact'
  printf '%s\\n' '# set of commands needed for JIT user provisioning. NO blanket ALL.'
  printf '%s\\n' 'nobody ALL=(root) NOPASSWD: /usr/sbin/useradd, /usr/sbin/usermod, /usr/sbin/userdel, /usr/sbin/gpasswd, /usr/bin/setfacl, /usr/sbin/setfacl'
  printf '%s\\n' 'nobody ALL=(root) NOPASSWD: /usr/bin/tee /etc/sudoers.d/shellius-*'
  printf '%s\\n' 'nobody ALL=(root) NOPASSWD: /bin/rm /etc/sudoers.d/shellius-*, /usr/bin/rm /etc/sudoers.d/shellius-*'
  printf '%s\\n' 'nobody ALL=(root) NOPASSWD: /bin/loginctl, /usr/bin/loginctl'
  printf '%s\\n' 'nobody ALL=(root) NOPASSWD: /bin/chmod /etc/sudoers.d/shellius-*, /usr/bin/chmod /etc/sudoers.d/shellius-*'
} > /etc/sudoers.d/shellius-check-principals
chmod 0440 /etc/sudoers.d/shellius-check-principals
chown root:0 /etc/sudoers.d/shellius-check-principals 2>/dev/null || true
# Validate the new sudoers file before continuing
if command -v visudo >/dev/null 2>&1; then
  if ! visudo -c -f /etc/sudoers.d/shellius-check-principals >/dev/null 2>&1; then
    echo "[shellius]   ! sudoers validation failed — removing bad drop-in" >&2
    rm -f /etc/sudoers.d/shellius-check-principals
  fi
fi

# ---------------------------------------------------------------------------
# 6. sshd config (drop-in if Includes; else in-place with markers)
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [6/${TOTAL}] Configuring sshd"
  # Only use sshd_config.d if the main sshd_config actually Includes it.
  # On some distros the directory exists but the Include line is missing or
  # commented out, which silently swallows our drop-in. Verify, don't assume.
  DROPIN_EFFECTIVE=0
  if grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d' "$SSHD_CONFIG" 2>/dev/null; then
    DROPIN_EFFECTIVE=1
  fi

  write_dropin() {
    install -d -m 755 "$SSH_DIR/sshd_config.d"
    {
      printf '%s\\n' '# Managed by Shellius bootstrap'
      printf 'TrustedUserCAKeys %s\\n' "$CA_PUB_PATH"
      printf 'AuthorizedPrincipalsCommand %s validate %%u %%s\\n' "$CHECK_PRINCIPALS_PATH"
      printf '%s\\n' 'AuthorizedPrincipalsCommandUser nobody'
    } > "$SSHD_DROPIN"
    chmod 644 "$SSHD_DROPIN"
  }

  write_inline() {
    # CRITICAL: insert the Shellius block BEFORE the first 'Match' line if
    # there is one. TrustedUserCAKeys / AuthorizedPrincipalsCommand* are NOT
    # permitted inside a Match block, and Ubuntu's default sshd_config ends
    # with 'Match Group sftponly'. Appending at EOF would put our directives
    # inside that match context and sshd would silently ignore them.
    cp "$SSHD_CONFIG" "$SSHD_CONFIG.bak.shellius"
    awk -v ca="$CA_PUB_PATH" -v cp="$CHECK_PRINCIPALS_PATH" '
      BEGIN { inserted = 0; in_block = 0 }
      /^# >>> shellius >>>/ { in_block = 1; next }
      /^# <<< shellius <<</ { in_block = 0; next }
      in_block { next }
      /^[[:space:]]*Match[[:space:]]/ && !inserted {
        print "# >>> shellius >>>"
        print "TrustedUserCAKeys " ca
        print "AuthorizedPrincipalsCommand " cp " validate %u %s"
        print "AuthorizedPrincipalsCommandUser nobody"
        print "# <<< shellius <<<"
        inserted = 1
      }
      { print }
      END {
        if (!inserted) {
          print "# >>> shellius >>>"
          print "TrustedUserCAKeys " ca
          print "AuthorizedPrincipalsCommand " cp " validate %u %s"
          print "AuthorizedPrincipalsCommandUser nobody"
          print "# <<< shellius <<<"
        }
      }
    ' "$SSHD_CONFIG.bak.shellius" > "$SSHD_CONFIG"
  }

  if [ "$DROPIN_EFFECTIVE" = "1" ]; then
    write_dropin
    echo "[shellius]   Wrote drop-in (sshd_config Includes sshd_config.d)"
  else
    echo "[shellius]   sshd_config does not Include sshd_config.d; editing $SSHD_CONFIG directly"
    write_inline
    rm -f "$SSHD_DROPIN"
  fi
else
  echo "[shellius] [6/${TOTAL}] Skipping sshd config (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 7. Reaper systemd units (Linux only)
# ---------------------------------------------------------------------------
echo "[shellius] [7/${TOTAL}] Installing JIT reaper systemd units"
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  {
    printf '%s\\n' '[Unit]'
    printf '%s\\n' 'Description=Shellius JIT user reaper'
    printf '%s\\n' 'After=network.target'
    printf '%s\\n' ''
    printf '%s\\n' '[Service]'
    printf '%s\\n' 'Type=oneshot'
    printf 'ExecStart=%s reap\\n' "$CHECK_PRINCIPALS_PATH"
    printf '%s\\n' 'User=root'
    printf '%s\\n' 'StandardOutput=journal'
    printf '%s\\n' 'StandardError=journal'
    printf '%s\\n' 'SyslogIdentifier=shellius-jit-reap'
  } > /etc/systemd/system/shellius-jit-reap.service

  {
    printf '%s\\n' '[Unit]'
    printf '%s\\n' 'Description=Shellius JIT user reaper timer'
    printf '%s\\n' ''
    printf '%s\\n' '[Timer]'
    printf '%s\\n' 'OnBootSec=5min'
    printf '%s\\n' 'OnUnitActiveSec=5min'
    printf '%s\\n' 'Unit=shellius-jit-reap.service'
    printf '%s\\n' ''
    printf '%s\\n' '[Install]'
    printf '%s\\n' 'WantedBy=timers.target'
  } > /etc/systemd/system/shellius-jit-reap.timer

  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now shellius-jit-reap.timer 2>/dev/null || true
  echo "[shellius]   JIT reaper timer enabled (shellius-jit-reap.timer)"
else
  echo "[shellius]   Skipping reaper timer (not Linux or no systemd)"
fi

# ---------------------------------------------------------------------------
# 8. Heartbeat timer (Linux only)
#
# Always rewrite the unit so re-onboarding picks up the current API URL — the
# old behaviour skipped this block if the service file already existed, which
# left re-bootstrapped hosts heart-beating to a stale endpoint. Writing the
# unit unconditionally + daemon-reload + enable --now is fully idempotent
# (mirrors the JIT reaper timer in step 7).
# ---------------------------------------------------------------------------
echo "[shellius] [8/${TOTAL}] Installing heartbeat systemd timer"
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  # Heartbeat script — serverId/orgId are baked in (the org-wide agent token
  # cannot identify the host); agentId/hostname/ip are computed at runtime.
  # Form-urlencoded (--data-urlencode) avoids JSON quoting in the script.
  {
    printf '%s\\n' '#!/bin/bash'
    printf '%s\\n' 'TOKEN=$(cat /etc/shellius/agent-token 2>/dev/null)'
    printf '%s\\n' '[ -z "$TOKEN" ] && exit 0'
    printf '%s\\n' 'HN=$(hostname)'
    printf '%s\\n' 'IP=$(hostname -I 2>/dev/null)'
    printf '%s\\n' 'IP=\${IP%% *}'
    printf '%s\\n' 'curl -fsS --max-time 10 -H "x-agent-token: $TOKEN" -X POST ${apiUrl}/api/hosts/heartbeat --data-urlencode "agentId=$HN" --data-urlencode "serverId=${serverId}" --data-urlencode "orgId=${orgId}" --data-urlencode "hostname=$HN" --data-urlencode "ipAddress=$IP" >/dev/null 2>&1 || true'
  } > /usr/local/sbin/shellius-heartbeat
  chmod 755 /usr/local/sbin/shellius-heartbeat

  {
    printf '%s\\n' '[Unit]'
    printf '%s\\n' 'Description=Shellius agent heartbeat'
    printf '%s\\n' 'After=network.target'
    printf '%s\\n' ''
    printf '%s\\n' '[Service]'
    printf '%s\\n' 'Type=oneshot'
    printf '%s\\n' 'User=root'
    printf '%s\\n' 'ExecStart=/usr/local/sbin/shellius-heartbeat'
  } > /etc/systemd/system/shellius-heartbeat.service

  {
    printf '%s\\n' '[Unit]'
    printf '%s\\n' 'Description=Shellius agent heartbeat timer'
    printf '%s\\n' ''
    printf '%s\\n' '[Timer]'
    printf '%s\\n' 'OnBootSec=60s'
    printf '%s\\n' 'OnUnitActiveSec=60s'
    printf '%s\\n' 'Unit=shellius-heartbeat.service'
    printf '%s\\n' ''
    printf '%s\\n' '[Install]'
    printf '%s\\n' 'WantedBy=timers.target'
  } > /etc/systemd/system/shellius-heartbeat.timer

  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now shellius-heartbeat.timer 2>/dev/null || true
  echo "[shellius]   Heartbeat timer installed/updated and enabled"
else
  echo "[shellius]   Skipping heartbeat timer (not Linux or no systemd)"
fi

# ---------------------------------------------------------------------------
# 9. Logrotate drop-in
# ---------------------------------------------------------------------------
echo "[shellius] [9/${TOTAL}] Installing logrotate drop-in"
if [ -d /etc/logrotate.d ]; then
  {
    printf '%s\\n' '/var/log/shellius-jit.log {'
    printf '%s\\n' '  daily'
    printf '%s\\n' '  rotate 14'
    printf '%s\\n' '  compress'
    printf '%s\\n' '  delaycompress'
    printf '%s\\n' '  missingok'
    printf '%s\\n' '  notifempty'
    printf '%s\\n' '  create 640 root adm'
    printf '%s\\n' '}'
  } > /etc/logrotate.d/shellius-jit
  chmod 644 /etc/logrotate.d/shellius-jit
  echo "[shellius]   Logrotate drop-in installed (/etc/logrotate.d/shellius-jit)"
else
  echo "[shellius]   /etc/logrotate.d not found — skipping logrotate drop-in"
fi

${POSTURE_INSTALL_BLOCK}
# ---------------------------------------------------------------------------
# 12. Validate sshd config
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [${STEP_VALIDATE}/${TOTAL}] Validating sshd configuration"
  if command -v sshd >/dev/null 2>&1; then
    sshd -t
  fi
else
  echo "[shellius] [${STEP_VALIDATE}/${TOTAL}] Skipping sshd validation (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 13. Reload sshd
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [${STEP_RELOAD}/${TOTAL}] Reloading sshd"
  if [ "$PLATFORM" = "macos" ]; then
    launchctl kickstart -k system/com.openssh.sshd 2>/dev/null || true
  else
    if command -v systemctl >/dev/null 2>&1; then
      systemctl reload ssh 2>/dev/null \\
        || systemctl reload sshd 2>/dev/null \\
        || systemctl restart ssh 2>/dev/null \\
        || systemctl restart sshd 2>/dev/null || true
    else
      service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || true
    fi
  fi
else
  echo "[shellius] [${STEP_RELOAD}/${TOTAL}] Skipping sshd reload (--upgrade; check-principals update is live immediately)"
fi

# ---------------------------------------------------------------------------
# 14. Self-test — fail loudly if anything is wrong
# ---------------------------------------------------------------------------
echo "[shellius] [${STEP_SELFTEST}/${TOTAL}] Running self-test"
SELF_TEST_FAIL=0

if [ "\$UPGRADE_ONLY" = "0" ]; then
  # 12a. sshd's effective config must include our directives
  if command -v sshd >/dev/null 2>&1 && sshd -T >/dev/null 2>&1; then
    TRUST_LINE="\$(sshd -T 2>/dev/null | grep -i '^trustedusercakeys ' || true)"
    PRINC_LINE="\$(sshd -T 2>/dev/null | grep -i '^authorizedprincipalscommand ' || true)"
    PRINC_USER_LINE="\$(sshd -T 2>/dev/null | grep -i '^authorizedprincipalscommanduser ' || true)"

    if echo "\$TRUST_LINE" | grep -qi "$CA_PUB_PATH"; then
      echo "[shellius]   [OK] sshd trusts $CA_PUB_PATH"
    else
      echo "[shellius]   [FAIL] TrustedUserCAKeys not effective. sshd -T shows: \${TRUST_LINE:-(missing)}"
      SELF_TEST_FAIL=1
    fi
    if echo "\$PRINC_LINE" | grep -qi "$CHECK_PRINCIPALS_PATH"; then
      echo "[shellius]   [OK] sshd has AuthorizedPrincipalsCommand"
    else
      echo "[shellius]   [FAIL] AuthorizedPrincipalsCommand not effective. sshd -T shows: \${PRINC_LINE:-(missing or 'none')}"
      echo "[shellius]     This usually means sshd rejected an unsupported %-token."
      echo "[shellius]     Check the line in /etc/ssh/sshd_config and validate with: sudo sshd -t -f /etc/ssh/sshd_config"
      SELF_TEST_FAIL=1
    fi
    if echo "\$PRINC_USER_LINE" | grep -qi 'nobody'; then
      echo "[shellius]   [OK] sshd has AuthorizedPrincipalsCommandUser=nobody"
    else
      echo "[shellius]   [FAIL] AuthorizedPrincipalsCommandUser not effective. sshd -T shows: \${PRINC_USER_LINE:-(missing)}"
      SELF_TEST_FAIL=1
    fi
  else
    echo "[shellius]   ! sshd -T unavailable; skipping effective-config check"
  fi

  # 12b. 'nobody' must be able to read the agent token
  if id nobody >/dev/null 2>&1; then
    if sudo -u nobody cat "$AGENT_TOKEN_PATH" >/dev/null 2>&1; then
      echo "[shellius]   [OK] 'nobody' can read $AGENT_TOKEN_PATH"
    else
      echo "[shellius]   [FAIL] 'nobody' CANNOT read $AGENT_TOKEN_PATH (dir or file perms wrong)"
      ls -ld "$AGENT_DIR" "$AGENT_TOKEN_PATH" >&2
      SELF_TEST_FAIL=1
    fi
  else
    echo "[shellius]   ! 'nobody' user does not exist; skipping token-read check"
  fi

  # 12c. CA fingerprint sanity check
  if command -v ssh-keygen >/dev/null 2>&1; then
    echo "[shellius]   CA fingerprint: $(ssh-keygen -lf "$CA_PUB_PATH" 2>/dev/null | awk '{print $2}')"
  fi

  # 12d. Local user sanity check
  if id "${sshUser}" >/dev/null 2>&1; then
    echo "[shellius]   [OK] local user '${sshUser}' exists"
  else
    echo "[shellius]   ! local user '${sshUser}' does NOT exist on this host."
    echo "[shellius]     Create it with: sudo useradd -m -s /bin/bash ${sshUser}"
    echo "[shellius]     (not a fatal error — but SSH cert auth will fail until the user exists)"
  fi
fi

# 12e. check-principals script must be executable and contain v2 marker
if [ -x "$CHECK_PRINCIPALS_PATH" ]; then
  echo "[shellius]   [OK] check-principals is executable"
  if grep -q 'reap_expired_leases' "$CHECK_PRINCIPALS_PATH" 2>/dev/null; then
    echo "[shellius]   [OK] check-principals v2 (JIT provisioning) installed"
  else
    echo "[shellius]   ! check-principals appears to be v1 (no JIT support)"
  fi
else
  echo "[shellius]   [FAIL] check-principals not found or not executable at $CHECK_PRINCIPALS_PATH"
  SELF_TEST_FAIL=1
fi

# 12f. JIT reaper timer check
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled shellius-jit-reap.timer >/dev/null 2>&1; then
    echo "[shellius]   [OK] shellius-jit-reap.timer is enabled"
  else
    echo "[shellius]   ! shellius-jit-reap.timer not enabled — run: systemctl enable --now shellius-jit-reap.timer"
  fi
fi

# 12g. jq availability (required for JIT manifest parsing)
if command -v jq >/dev/null 2>&1; then
  echo "[shellius]   [OK] jq available (\$(jq --version 2>/dev/null || echo unknown))"
else
  echo "[shellius]   ! jq not found — JIT provisioning will fall back to legacy mode"
fi

${POSTURE_SELFTEST_BLOCK}

if [ "\$SELF_TEST_FAIL" -ne 0 ]; then
  echo "[shellius] [FAIL] Self-test FAILED. Inspect the messages above."
  echo "[shellius]   Quick diagnostics:"
  echo "[shellius]     sudo sshd -T | grep -iE 'trustedusercakeys|authorizedprincipals'"
  echo "[shellius]     sudo journalctl -t shellius-check-principals -n 30 --no-pager"
  echo "[shellius]     sudo journalctl -u ssh -n 30 --no-pager"
  exit 1
fi

echo "[shellius] [OK] Bootstrap v2 complete."
echo "[shellius]   Host:              ${hostname}"
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius]   CA trust:          $CA_PUB_PATH"
fi
echo "[shellius]   Agent token:       $AGENT_TOKEN_PATH (rotated this run)"
echo "[shellius]   Check script:      $CHECK_PRINCIPALS_PATH"
echo "[shellius]   JIT lease dir:     $JIT_DIR"
echo "[shellius]   JIT log:           $JIT_LOG"
if [ "$PLATFORM" = "linux" ]; then
  echo "[shellius]   Reaper timer:      shellius-jit-reap.timer (5 min)"
fi
${POSTURE_SUMMARY_BLOCK}
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius]   Login user:        ${sshUser}"
  echo "[shellius]   You can now Open Web Terminal in the Shellius UI."
fi
`;
}

// ---------------------------------------------------------------------------
// buildPostureOnlyInstallScript — mode=posture
// ---------------------------------------------------------------------------
//
// Reduced installer for hosts that never run the full bootstrap — today
// that's exactly authMode: 'credential' servers (ServerDetail.jsx hides the
// bootstrap card for them and tells the user "no agent or bootstrap is
// required"), which left them a permanent posture blind spot. See
// docs/posture/posture-spec.md §4.
//
// OWNS (installs/upgrades, and is the only mode that owns these):
//   /usr/local/sbin/shellius-posture-collect, shellius-posture-report
//   /etc/systemd/system/shellius-posture.{service,timer}
//   /etc/sudoers.d/shellius-posture
//   the 'shellius-posture' unprivileged system account
//
// SHARES (writes, but does not exclusively own):
//   /etc/shellius/agent-token — the one per-host token used by every
//   agent-authenticated endpoint (heartbeat, certificates/verify, posture
//   ingest). Whichever install script (full or posture-only) runs last
//   mints the current token server-side and overwrites this file to match;
//   that is intentional rotation, identical to how the full script already
//   treats this file (see buildUnixInstallScript step 2).
//
// NEVER TOUCHES (exclusively owned by mode=full / buildUnixInstallScript):
//   /etc/ssh/shellius_ca.pub, TrustedUserCAKeys, AuthorizedPrincipalsCommand,
//   /etc/ssh/sshd_config(.d), /usr/local/sbin/shellius-check-principals,
//   the JIT reaper timer/dirs, the heartbeat timer, sshd itself.
//
// Idempotent and re-runnable. Accepts (and no-ops) --upgrade for symmetry
// with the full script's CLI — every step here already re-applies on every
// invocation, so there's no separate "upgrade only" code path to gate.
function buildPostureOnlyInstallScript({ apiUrl, agentToken, hostname }) {
  const postureReportScript = POSTURE_ASSETS.report
    ? POSTURE_ASSETS.report.replace('__SHELLIUS_POSTURE_API_URL__', apiUrl)
    : null;
  const postureCollectB64 = POSTURE_ASSETS.collect
    ? Buffer.from(POSTURE_ASSETS.collect, 'utf8').toString('base64')
    : '';
  const postureReportB64 = postureReportScript
    ? Buffer.from(postureReportScript, 'utf8').toString('base64')
    : '';
  const postureServiceB64 = POSTURE_ASSETS.service
    ? Buffer.from(POSTURE_ASSETS.service, 'utf8').toString('base64')
    : '';
  const postureTimerB64 = POSTURE_ASSETS.timer
    ? Buffer.from(POSTURE_ASSETS.timer, 'utf8').toString('base64')
    : '';
  const postureSudoersB64 = POSTURE_ASSETS.sudoers
    ? Buffer.from(POSTURE_ASSETS.sudoers, 'utf8').toString('base64')
    : '';
  const postureContainerSudoersB64 = POSTURE_ASSETS.containerSudoers
    ? Buffer.from(POSTURE_ASSETS.containerSudoers, 'utf8').toString('base64')
    : '';

  return `#!/usr/bin/env bash
# Shellius POSTURE-ONLY host install — mode=posture
# Target host: ${hostname}
#
# OWNERSHIP — read before assuming this touches SSH at all:
#   Installs ONLY: the posture collector scripts, the
#   shellius-posture.service/.timer systemd units, a narrow
#   /etc/sudoers.d/shellius-posture drop-in, the unprivileged
#   'shellius-posture' system account, and the per-host agent token at
#   /etc/shellius/agent-token (shared — see below).
#
#   It NEVER writes /etc/ssh/shellius_ca.pub, never edits sshd_config or
#   sshd_config.d, never installs check-principals, the JIT reaper, or the
#   heartbeat timer. Those belong exclusively to the FULL bootstrap
#   (mode=full — "sudo bash install.sh" with no posture-only token), which
#   servers with authMode: 'credential' deliberately never run. This script
#   is how those hosts get posture coverage without SSH cert auth being
#   touched in any way.
#
#   Coexistence: /etc/shellius/agent-token is the one path both modes
#   write. It holds a single per-host token used by every agent-
#   authenticated endpoint (heartbeat, certificates/verify, posture
#   ingest) — whichever script (full or posture-only) runs last mints and
#   writes the current token; that's the existing rotation model, not new
#   behaviour. If the FULL agent is already on this host, re-running this
#   script only touches the posture collector pieces above plus that
#   shared token file — it never disturbs CA trust or sshd. See
#   uninstall.sh (mode=posture) for the matching guard on removal.
#
# Idempotent: safe to re-run. --upgrade is accepted for symmetry with the
# full install script's CLI; every step below already re-applies on every
# run, so there is no distinct upgrade-only behaviour here.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

for arg in "\$@"; do
  if [ "\$arg" = "--upgrade" ]; then
    echo "[shellius] Mode: --upgrade (no-op here — posture-only install is always fully idempotent)"
  fi
done

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) echo "ERROR: unsupported platform: $UNAME_S" >&2; exit 1 ;;
esac
echo "[shellius] Detected platform: $PLATFORM"

if [ "$PLATFORM" != "linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "[shellius] Posture v1 requires Linux + systemd (docs/posture/posture-spec.md §1)." >&2
  echo "[shellius] This host is unsupported for the collector — nothing to install." >&2
  exit 0
fi

AGENT_DIR=/etc/shellius
AGENT_TOKEN_PATH="$AGENT_DIR/agent-token"
POSTURE_USER=shellius-posture
POSTURE_COLLECT_PATH=/usr/local/sbin/shellius-posture-collect
POSTURE_REPORT_PATH=/usr/local/sbin/shellius-posture-report

AGENT_SECRET_B64='${Buffer.from(agentToken + '\n', 'utf8').toString('base64')}'
POSTURE_COLLECT_B64='${postureCollectB64}'
POSTURE_REPORT_B64='${postureReportB64}'
POSTURE_SERVICE_B64='${postureServiceB64}'
POSTURE_TIMER_B64='${postureTimerB64}'
POSTURE_SUDOERS_B64='${postureSudoersB64}'
POSTURE_CONTAINER_SUDOERS_B64='${postureContainerSudoersB64}'

if [ -z "\$POSTURE_COLLECT_B64" ] || [ -z "\$POSTURE_REPORT_B64" ] || [ -z "\$POSTURE_SERVICE_B64" ] \\
   || [ -z "\$POSTURE_TIMER_B64" ] || [ -z "\$POSTURE_SUDOERS_B64" ]; then
  echo "[shellius] [FAIL] Posture collector assets are missing from this deployment's image (scripts/posture/ not shipped)." >&2
  echo "[shellius]   Posture-only mode has nothing else to install — aborting." >&2
  exit 1
fi

CONTAINER_SCAN=""
for arg in "\$@"; do
  [ "\$arg" = "--with-container-scan" ] && CONTAINER_SCAN=1
  [ "\$arg" = "--no-container-scan" ] && CONTAINER_SCAN=0
done

echo "[shellius] [1/5] Writing per-host agent token → $AGENT_TOKEN_PATH"
install -d "$AGENT_DIR"
# Force mode 755 even if the directory pre-exists (e.g. from a prior full
# install) — see buildUnixInstallScript step 2 for why this must not be
# left at a stricter mode.
chmod 755 "$AGENT_DIR"
chown root:0 "$AGENT_DIR" 2>/dev/null || chown root:wheel "$AGENT_DIR" 2>/dev/null || true
echo "\$AGENT_SECRET_B64" | base64 -d > "$AGENT_TOKEN_PATH"
chmod 644 "$AGENT_TOKEN_PATH"
chown root:0 "$AGENT_TOKEN_PATH" 2>/dev/null || chown root:wheel "$AGENT_TOKEN_PATH" 2>/dev/null || true

echo "[shellius] [2/5] Installing posture collector scripts"
install -d -m 755 /usr/local/sbin
echo "\$POSTURE_COLLECT_B64" | base64 -d > "$POSTURE_COLLECT_PATH"
chmod 755 "$POSTURE_COLLECT_PATH"
chown root:0 "$POSTURE_COLLECT_PATH" 2>/dev/null || chown root:wheel "$POSTURE_COLLECT_PATH" 2>/dev/null || true
echo "\$POSTURE_REPORT_B64" | base64 -d > "$POSTURE_REPORT_PATH"
chmod 755 "$POSTURE_REPORT_PATH"
chown root:0 "$POSTURE_REPORT_PATH" 2>/dev/null || chown root:wheel "$POSTURE_REPORT_PATH" 2>/dev/null || true

echo "[shellius] [3/5] Creating '\$POSTURE_USER' unprivileged system account"
if ! id -u "\$POSTURE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "\$POSTURE_USER" 2>/dev/null \\
    || useradd -r -M -s /usr/sbin/nologin "\$POSTURE_USER" 2>/dev/null \\
    || { echo "[shellius]   [FAIL] could not create \$POSTURE_USER user" >&2; exit 1; }
fi

echo "[shellius] [4/5] Installing narrow sudoers drop-in + systemd unit/timer"
# Optional, off by default: see the full installer and
# scripts/posture/shellius-posture-containers.sudoers for what this grant
# does and does not allow. Without it the collector cannot see a STOPPED
# container, so that container's surviving firewall rule reports as an
# abandoned rule rather than a service one docker-start from reachable.
if [ "\$CONTAINER_SCAN" = "1" ] && [ -n "\$POSTURE_CONTAINER_SUDOERS_B64" ]; then
  echo "\$POSTURE_CONTAINER_SUDOERS_B64" | base64 -d > /etc/sudoers.d/shellius-posture-containers
  chmod 0440 /etc/sudoers.d/shellius-posture-containers
  chown root:0 /etc/sudoers.d/shellius-posture-containers 2>/dev/null || true
  if command -v visudo >/dev/null 2>&1 && ! visudo -c -f /etc/sudoers.d/shellius-posture-containers >/dev/null 2>&1; then
    echo "[shellius]   ! container sudoers validation failed — removing bad drop-in" >&2
    rm -f /etc/sudoers.d/shellius-posture-containers
  else
    echo "[shellius]   Container state scan ENABLED (stopped containers will be reported)"
  fi
elif [ "\$CONTAINER_SCAN" = "0" ]; then
  rm -f /etc/sudoers.d/shellius-posture-containers
  echo "[shellius]   Container state scan disabled"
fi
echo "\$POSTURE_SUDOERS_B64" | base64 -d > /etc/sudoers.d/shellius-posture
chmod 0440 /etc/sudoers.d/shellius-posture
chown root:0 /etc/sudoers.d/shellius-posture 2>/dev/null || true
if command -v visudo >/dev/null 2>&1; then
  if ! visudo -c -f /etc/sudoers.d/shellius-posture >/dev/null 2>&1; then
    echo "[shellius]   [FAIL] posture sudoers validation failed — removing bad drop-in" >&2
    rm -f /etc/sudoers.d/shellius-posture
    exit 1
  fi
fi
echo "\$POSTURE_SERVICE_B64" | base64 -d > /etc/systemd/system/shellius-posture.service
echo "\$POSTURE_TIMER_B64" | base64 -d > /etc/systemd/system/shellius-posture.timer
chmod 644 /etc/systemd/system/shellius-posture.service /etc/systemd/system/shellius-posture.timer
systemctl daemon-reload 2>/dev/null || true
if ! systemctl enable --now shellius-posture.timer 2>/dev/null; then
  echo "[shellius]   [FAIL] could not enable shellius-posture.timer" >&2
  exit 1
fi
echo "[shellius]   Posture collector timer enabled (shellius-posture.timer, every 5 min)"

echo "[shellius] [5/5] Running self-test"
SELF_TEST_FAIL=0
if [ -x "$POSTURE_COLLECT_PATH" ] && [ -x "$POSTURE_REPORT_PATH" ]; then
  echo "[shellius]   [OK] collector scripts installed and executable"
else
  echo "[shellius]   [FAIL] collector scripts missing or not executable" >&2
  SELF_TEST_FAIL=1
fi
if systemctl is-enabled shellius-posture.timer >/dev/null 2>&1; then
  echo "[shellius]   [OK] shellius-posture.timer is enabled"
else
  echo "[shellius]   [FAIL] shellius-posture.timer is not enabled" >&2
  SELF_TEST_FAIL=1
fi
if [ -r "$AGENT_TOKEN_PATH" ]; then
  echo "[shellius]   [OK] agent token present at $AGENT_TOKEN_PATH"
else
  echo "[shellius]   [FAIL] agent token missing at $AGENT_TOKEN_PATH" >&2
  SELF_TEST_FAIL=1
fi
if command -v sudo >/dev/null 2>&1 && sudo -n -u "\$POSTURE_USER" sudo -n -l >/dev/null 2>&1; then
  echo "[shellius]   [OK] \$POSTURE_USER has an active sudoers grant"
else
  echo "[shellius]   ! could not confirm \$POSTURE_USER's sudoers grant (non-fatal — checked as root, not as \$POSTURE_USER)"
fi

if [ "\$SELF_TEST_FAIL" -ne 0 ]; then
  echo "[shellius] [FAIL] Self-test FAILED. Inspect the messages above."
  echo "[shellius]   Quick diagnostics:"
  echo "[shellius]     sudo systemctl status shellius-posture.timer"
  echo "[shellius]     sudo journalctl -t shellius-posture -n 30 --no-pager"
  exit 1
fi

echo "[shellius] [OK] Posture-only install complete."
echo "[shellius]   Host:              ${hostname}"
echo "[shellius]   Mode:              posture-only (no CA trust, no sshd changes, no check-principals)"
echo "[shellius]   Agent token:       $AGENT_TOKEN_PATH (rotated this run)"
echo "[shellius]   Posture collector: shellius-posture.timer (every 5 min, user \$POSTURE_USER)"
echo "[shellius]   Reports to:        ${apiUrl}"
echo "[shellius]   To add full SSH certificate access later, generate a FULL bootstrap"
echo "[shellius]   link from Shellius for this server — it layers CA trust and"
echo "[shellius]   check-principals on top without disturbing this collector."
`;
}

// ---------------------------------------------------------------------------
// buildUnixUninstallScript — reverses what buildUnixInstallScript did
// ---------------------------------------------------------------------------
//
// SAFETY RULES (Task 17C — these are non-negotiable):
//   - NEVER touch /etc/ssh/ssh_host_*
//   - NEVER touch /etc/ssh/ssh_known_hosts
//   - NEVER touch any user's authorized_keys (any path)
//   - NEVER touch /root/.ssh/ or any user's ~/.ssh/
//   - NEVER touch any Include directive or unrelated drop-in
//   - ALWAYS back up sshd_config before any sed edit
//   - ALWAYS run 'sshd -t' BEFORE the systemd reload
//   - REFUSE to reload sshd if validation fails — restore the backup
//
// What it removes (and ONLY these):
//   /etc/ssh/shellius_ca.pub
//   /etc/ssh/sshd_config.d/99-shellius.conf      (if present)
//   /etc/shellius/agent-token
//   /etc/shellius/                              (if empty after token removal)
//   /usr/local/sbin/shellius-check-principals
//   /usr/local/sbin/shellius-posture-collect, shellius-posture-report
//   /etc/systemd/system/shellius-posture.{service,timer} (disabled first)
//   /etc/sudoers.d/shellius-posture
//   the 'shellius-posture' system user (only if we can confirm Shellius
//     created it — see step 6; a name collision with a pre-existing local
//     account is left alone)
//   The exact "# >>> shellius >>> ... # <<< shellius <<<" block in
//     /etc/ssh/sshd_config — and ONLY between those markers
//
// Steps 6-7 of the uninstall script: tearing the posture collector back out.
// Extracted so an `ssh`-mode uninstall can SKIP them — on a host where the
// collector was installed separately (mode=posture), removing the SSH agent
// must not silently take posture down with it.
const POSTURE_UNINSTALL_TEMPLATE = `# ---------------------------------------------------------------------------
# 6. Remove posture systemd unit/timer, sudoers drop-in, and the
#    'shellius-posture' service account. Independent of sshd entirely — no
#    backup/validate/reload dance needed, this never touches SSH trust.
# ---------------------------------------------------------------------------
echo "[shellius] [6/8] Removing posture collector systemd units + sudoers"
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files shellius-posture.timer >/dev/null 2>&1; then
    systemctl disable --now shellius-posture.timer >/dev/null 2>&1 || true
  fi
  if [ -f "$POSTURE_TIMER" ]; then rm -f "$POSTURE_TIMER"; REMOVED+=("$POSTURE_TIMER"); fi
  if [ -f "$POSTURE_SERVICE" ]; then rm -f "$POSTURE_SERVICE"; REMOVED+=("$POSTURE_SERVICE"); fi
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
if [ -f "$POSTURE_SUDOERS" ]; then
  rm -f "$POSTURE_SUDOERS"
  REMOVED+=("$POSTURE_SUDOERS")
fi
# Only remove the account if it looks like the one Shellius created
# (system account, no home directory, nologin shell) — never touch a local
# account that merely happens to share the name.
if id -u "$POSTURE_USER" >/dev/null 2>&1; then
  POSTURE_UID="$(id -u "$POSTURE_USER" 2>/dev/null || echo '')"
  POSTURE_SHELL="$(getent passwd "$POSTURE_USER" 2>/dev/null | cut -d: -f7)"
  if [ -n "$POSTURE_UID" ] && [ "$POSTURE_UID" -lt 1000 ] && { [ "$POSTURE_SHELL" = "/usr/sbin/nologin" ] || [ "$POSTURE_SHELL" = "/sbin/nologin" ]; }; then
    userdel "$POSTURE_USER" >/dev/null 2>&1 && REMOVED+=("user: $POSTURE_USER") || true
  else
    echo "[shellius]   $POSTURE_USER exists but doesn't look Shellius-created (uid=$POSTURE_UID shell=$POSTURE_SHELL) — leaving it in place"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Remove posture collector + report scripts
# ---------------------------------------------------------------------------
echo "[shellius] [7/8] Removing posture collector scripts"
if [ -f "$POSTURE_COLLECT_PATH" ]; then rm -f "$POSTURE_COLLECT_PATH"; REMOVED+=("$POSTURE_COLLECT_PATH"); fi
if [ -f "$POSTURE_REPORT_PATH" ]; then rm -f "$POSTURE_REPORT_PATH"; REMOVED+=("$POSTURE_REPORT_PATH"); fi

# ---------------------------------------------------------------------------
# 8. Validate sshd config and reload — refuses if validation fails`;

function buildUnixUninstallScript({ hostname, mode = 'full' }) {
  // 'ssh' leaves the posture collector alone; 'full' removes everything it
  // installed. (mode 'posture' has its own dedicated uninstall generator.)
  const withPosture = mode !== 'ssh';
  const POSTURE_UNINSTALL_BLOCK = withPosture
    ? POSTURE_UNINSTALL_TEMPLATE
    : 'echo "[shellius] [6/8] Leaving the posture collector installed (SSH-only uninstall)"';
  return `#!/usr/bin/env bash
# Shellius host UNINSTALL — reverses what install.sh did, safely.
# Target host: ${hostname}
#
# Safety: this script never touches authorized_keys, host keys, known_hosts,
# Include directives, or any unrelated drop-in. It backs up sshd_config
# before any edit and refuses to reload sshd if 'sshd -t' fails on the
# resulting config (it restores the backup in that case).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) echo "ERROR: unsupported platform: $UNAME_S" >&2; exit 1 ;;
esac
echo "[shellius] Detected platform: $PLATFORM"

CA_PUB=/etc/ssh/shellius_ca.pub
AGENT_DIR=/etc/shellius
AGENT_TOKEN=$AGENT_DIR/agent-token
CHECK_SCRIPT=/usr/local/sbin/shellius-check-principals
SSHD_CONFIG=/etc/ssh/sshd_config
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-shellius.conf
SSHD_BACKUP=/etc/ssh/sshd_config.shellius.bak
POSTURE_USER=shellius-posture
POSTURE_COLLECT_PATH=/usr/local/sbin/shellius-posture-collect
POSTURE_REPORT_PATH=/usr/local/sbin/shellius-posture-report
POSTURE_SERVICE=/etc/systemd/system/shellius-posture.service
POSTURE_TIMER=/etc/systemd/system/shellius-posture.timer
POSTURE_SUDOERS=/etc/sudoers.d/shellius-posture

REMOVED=()
TOUCHED_SSHD=0

# ---------------------------------------------------------------------------
# 1. Remove the drop-in (entirely Shellius-owned, safe to delete outright)
# ---------------------------------------------------------------------------
echo "[shellius] [1/8] Removing drop-in"
if [ -f "$SSHD_DROPIN" ]; then
  rm -f "$SSHD_DROPIN"
  REMOVED+=("$SSHD_DROPIN")
fi

# ---------------------------------------------------------------------------
# 2. Strip the inline shellius block from sshd_config (between markers ONLY)
#    Backup first, edit second, validate third, reload fourth.
# ---------------------------------------------------------------------------
echo "[shellius] [2/8] Stripping inline block from sshd_config (if any)"
if grep -q '^# >>> shellius >>>' "$SSHD_CONFIG" 2>/dev/null; then
  cp -a "$SSHD_CONFIG" "$SSHD_BACKUP"
  chmod 600 "$SSHD_BACKUP"
  sed -i '/^# >>> shellius >>>/,/^# <<< shellius <<</d' "$SSHD_CONFIG"
  TOUCHED_SSHD=1
  REMOVED+=("$SSHD_CONFIG: shellius marker block (backup at $SSHD_BACKUP)")
fi

# ---------------------------------------------------------------------------
# 3. Remove CA public key
# ---------------------------------------------------------------------------
echo "[shellius] [3/8] Removing CA public key"
if [ -f "$CA_PUB" ]; then
  rm -f "$CA_PUB"
  REMOVED+=("$CA_PUB")
fi

# ---------------------------------------------------------------------------
# 4. Remove agent token + directory (only if directory is empty)
# ---------------------------------------------------------------------------
echo "[shellius] [4/8] Removing agent token"
if [ -f "$AGENT_TOKEN" ]; then
  rm -f "$AGENT_TOKEN"
  REMOVED+=("$AGENT_TOKEN")
fi
if [ -d "$AGENT_DIR" ]; then
  if rmdir "$AGENT_DIR" 2>/dev/null; then
    REMOVED+=("$AGENT_DIR")
  else
    echo "[shellius]   $AGENT_DIR is not empty — leaving it in place"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Remove check-principals script
# ---------------------------------------------------------------------------
echo "[shellius] [5/8] Removing check-principals script"
if [ -f "$CHECK_SCRIPT" ]; then
  rm -f "$CHECK_SCRIPT"
  REMOVED+=("$CHECK_SCRIPT")
fi

${POSTURE_UNINSTALL_BLOCK}
# ---------------------------------------------------------------------------
echo "[shellius] [8/8] Validating sshd config"
if command -v sshd >/dev/null 2>&1; then
  if ! sshd -t 2>/dev/null; then
    echo "[shellius] [FAIL] sshd -t FAILED after uninstall."
    if [ "$TOUCHED_SSHD" = "1" ] && [ -f "$SSHD_BACKUP" ]; then
      echo "[shellius]   Restoring sshd_config backup from $SSHD_BACKUP"
      cp -a "$SSHD_BACKUP" "$SSHD_CONFIG"
      sshd -t 2>/dev/null && echo "[shellius]   Restored config validates."
    fi
    echo "[shellius]   Aborting reload to keep sshd alive. Inspect:"
    echo "[shellius]     sudo sshd -t"
    echo "[shellius]     sudo grep -nE 'Trusted|Authorized|Match' $SSHD_CONFIG"
    exit 1
  fi
  echo "[shellius]   [OK] sshd -t passes"
fi

echo "[shellius] Reloading sshd"
if [ "$PLATFORM" = "macos" ]; then
  launchctl kickstart -k system/com.openssh.sshd 2>/dev/null || true
else
  if command -v systemctl >/dev/null 2>&1; then
    systemctl reload ssh 2>/dev/null \\
      || systemctl reload sshd 2>/dev/null \\
      || systemctl restart ssh 2>/dev/null \\
      || systemctl restart sshd 2>/dev/null || true
  else
    service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Self-test: confirm sshd no longer trusts the Shellius CA
# ---------------------------------------------------------------------------
if command -v sshd >/dev/null 2>&1 && sshd -T >/dev/null 2>&1; then
  if sshd -T 2>/dev/null | grep -qi "^trustedusercakeys $CA_PUB"; then
    echo "[shellius] ! sshd -T still references $CA_PUB — manual cleanup needed."
  else
    echo "[shellius] [OK] sshd no longer trusts the Shellius CA"
  fi
fi

echo
echo "[shellius] [OK] Uninstall complete."
if [ \${#REMOVED[@]} -eq 0 ]; then
  echo "[shellius]   Nothing to remove — Shellius was not installed on this host."
else
  echo "[shellius]   Removed:"
  for f in "\${REMOVED[@]}"; do echo "[shellius]     - $f"; done
fi
echo
echo "[shellius]   Untouched (by design):"
echo "[shellius]     - /etc/ssh/ssh_host_*           (host keys)"
echo "[shellius]     - /etc/ssh/ssh_known_hosts      (known hosts)"
echo "[shellius]     - ~/.ssh/authorized_keys        (every user's authorized_keys)"
echo "[shellius]     - any other Include directive or drop-in"
[ "$TOUCHED_SSHD" = "1" ] && echo "[shellius]   sshd_config backup: $SSHD_BACKUP (delete when satisfied)"
`;
}

// ---------------------------------------------------------------------------
// buildPostureOnlyUninstallScript — reverses buildPostureOnlyInstallScript,
// and ONLY that. mode=posture.
// ---------------------------------------------------------------------------
//
// Removes (and ONLY these):
//   /usr/local/sbin/shellius-posture-collect, shellius-posture-report
//   /etc/systemd/system/shellius-posture.{service,timer}  (disabled first)
//   /etc/sudoers.d/shellius-posture
//   the 'shellius-posture' system user (only if it still looks
//     Shellius-created — system uid, nologin shell; a colliding
//     pre-existing local account is left alone, same rule the full
//     uninstall already uses)
//
// GUARD — the confusing case this exists to handle: /etc/shellius/agent-token
// is SHARED with the full agent (one per-host token for every agent-
// authenticated endpoint). If this host also has the FULL agent installed —
// detected by the presence of check-principals, the CA public key, the sshd
// drop-in, or the inline sshd_config marker block — this script leaves the
// token and its directory alone. Deleting it would silently break
// check-principals's ability to verify certificates on the very next SSH
// login, which is exactly the kind of cross-mode damage this build was
// asked to prevent. The token is removed only when none of those full-agent
// markers are present, i.e. this host only ever had the posture-only
// installer run on it.
//
// NEVER touches sshd, CA trust, AuthorizedPrincipalsCommand, check-
// principals, or the JIT reaper/heartbeat timers — those are exclusively
// removed by the FULL uninstall script (mode=full).
function buildPostureOnlyUninstallScript({ hostname }) {
  return `#!/usr/bin/env bash
# Shellius POSTURE-ONLY UNINSTALL — mode=posture
# Target host: ${hostname}
#
# OWNERSHIP: reverses ONLY what the posture-only install script (mode=posture)
# installs. It NEVER touches /etc/ssh/shellius_ca.pub, sshd_config,
# sshd_config.d/99-shellius.conf, check-principals, the JIT reaper, or the
# heartbeat timer — those belong exclusively to the FULL agent (mode=full)
# and are removed only by the FULL uninstall script.
#
# GUARD: /etc/shellius/agent-token is SHARED between modes. If the FULL
# agent is also installed on this host (detected below), this script
# deliberately LEAVES the token and its directory in place — deleting it
# here would break check-principals's ability to verify certificates on
# every SSH login, i.e. it would break SSH access on a host this script has
# no business touching. The token is removed only when no full-agent
# markers are present.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) echo "ERROR: unsupported platform: $UNAME_S" >&2; exit 1 ;;
esac
echo "[shellius] Detected platform: $PLATFORM"

AGENT_DIR=/etc/shellius
AGENT_TOKEN=$AGENT_DIR/agent-token
POSTURE_USER=shellius-posture
POSTURE_COLLECT_PATH=/usr/local/sbin/shellius-posture-collect
POSTURE_REPORT_PATH=/usr/local/sbin/shellius-posture-report
POSTURE_SERVICE=/etc/systemd/system/shellius-posture.service
POSTURE_TIMER=/etc/systemd/system/shellius-posture.timer
POSTURE_SUDOERS=/etc/sudoers.d/shellius-posture
CHECK_SCRIPT=/usr/local/sbin/shellius-check-principals
CA_PUB=/etc/ssh/shellius_ca.pub
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-shellius.conf
SSHD_CONFIG=/etc/ssh/sshd_config

REMOVED=()

# ---------------------------------------------------------------------------
# 1. Detect whether the FULL agent is also on this host.
# ---------------------------------------------------------------------------
FULL_AGENT_PRESENT=0
if [ -f "$CHECK_SCRIPT" ] || [ -f "$CA_PUB" ] || [ -f "$SSHD_DROPIN" ] \\
   || grep -q '^# >>> shellius >>>' "$SSHD_CONFIG" 2>/dev/null; then
  FULL_AGENT_PRESENT=1
  echo "[shellius]   Full Shellius agent detected on this host — leaving CA trust, sshd"
  echo "[shellius]   config, check-principals, and the shared agent token untouched."
fi

# ---------------------------------------------------------------------------
# 2. Remove posture systemd unit/timer + sudoers drop-in
# ---------------------------------------------------------------------------
echo "[shellius] [1/4] Removing posture collector systemd units + sudoers"
if [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files shellius-posture.timer >/dev/null 2>&1; then
    systemctl disable --now shellius-posture.timer >/dev/null 2>&1 || true
  fi
  if [ -f "$POSTURE_TIMER" ]; then rm -f "$POSTURE_TIMER"; REMOVED+=("$POSTURE_TIMER"); fi
  if [ -f "$POSTURE_SERVICE" ]; then rm -f "$POSTURE_SERVICE"; REMOVED+=("$POSTURE_SERVICE"); fi
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
if [ -f "$POSTURE_SUDOERS" ]; then
  rm -f "$POSTURE_SUDOERS"
  REMOVED+=("$POSTURE_SUDOERS")
fi

# ---------------------------------------------------------------------------
# 3. Remove the 'shellius-posture' account — only if it looks Shellius-created
#    (same rule the full uninstall script uses for the same account).
# ---------------------------------------------------------------------------
echo "[shellius] [2/4] Removing '$POSTURE_USER' account (if Shellius-created)"
if id -u "$POSTURE_USER" >/dev/null 2>&1; then
  POSTURE_UID="$(id -u "$POSTURE_USER" 2>/dev/null || echo '')"
  POSTURE_SHELL="$(getent passwd "$POSTURE_USER" 2>/dev/null | cut -d: -f7)"
  if [ -n "$POSTURE_UID" ] && [ "$POSTURE_UID" -lt 1000 ] \\
     && { [ "$POSTURE_SHELL" = "/usr/sbin/nologin" ] || [ "$POSTURE_SHELL" = "/sbin/nologin" ]; }; then
    userdel "$POSTURE_USER" >/dev/null 2>&1 && REMOVED+=("user: $POSTURE_USER") || true
  else
    echo "[shellius]   $POSTURE_USER exists but doesn't look Shellius-created (uid=$POSTURE_UID shell=$POSTURE_SHELL) — leaving it in place"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Remove posture collector + report scripts
# ---------------------------------------------------------------------------
echo "[shellius] [3/4] Removing posture collector scripts"
if [ -f "$POSTURE_COLLECT_PATH" ]; then rm -f "$POSTURE_COLLECT_PATH"; REMOVED+=("$POSTURE_COLLECT_PATH"); fi
if [ -f "$POSTURE_REPORT_PATH" ]; then rm -f "$POSTURE_REPORT_PATH"; REMOVED+=("$POSTURE_REPORT_PATH"); fi

# ---------------------------------------------------------------------------
# 5. Remove the shared agent token — ONLY if the full agent is not present.
# ---------------------------------------------------------------------------
echo "[shellius] [4/4] Removing per-host agent token (posture-only hosts only)"
if [ "$FULL_AGENT_PRESENT" = "0" ]; then
  if [ -f "$AGENT_TOKEN" ]; then
    rm -f "$AGENT_TOKEN"
    REMOVED+=("$AGENT_TOKEN")
  fi
  if [ -d "$AGENT_DIR" ]; then
    if rmdir "$AGENT_DIR" 2>/dev/null; then
      REMOVED+=("$AGENT_DIR")
    else
      echo "[shellius]   $AGENT_DIR is not empty — leaving it in place"
    fi
  fi
else
  echo "[shellius]   Skipping — $AGENT_TOKEN is shared with the full agent still installed here"
fi

echo
echo "[shellius] [OK] Posture-only uninstall complete."
if [ \${#REMOVED[@]} -eq 0 ]; then
  echo "[shellius]   Nothing to remove — the posture-only collector was not installed on this host."
else
  echo "[shellius]   Removed:"
  for f in "\${REMOVED[@]}"; do echo "[shellius]     - $f"; done
fi
echo
echo "[shellius]   Untouched (by design):"
echo "[shellius]     - /etc/ssh/shellius_ca.pub, sshd_config, sshd_config.d/*"
echo "[shellius]     - /usr/local/sbin/shellius-check-principals, JIT reaper, heartbeat timer"
if [ "$FULL_AGENT_PRESENT" = "1" ]; then
  echo "[shellius]     - $AGENT_TOKEN (shared with the full agent still installed here)"
fi
`;
}

function buildWindowsInstallScript({ apiUrl, agentToken, caPubKey, hostname, protocol }) {
  // For RDP-only servers, there's nothing to do on the host — Shellius injects
  // credentials via Guacamole. We still emit a friendly message.
  if (protocol === 'rdp') {
    return `# Shellius host bootstrap — Windows (RDP only)
# Target host: ${hostname}
Write-Host "[shellius] This server is RDP-only. No host agent is required."
Write-Host "[shellius] Shellius injects RDP credentials through Guacamole at connect time."
Write-Host "[shellius] Ensure the Windows account Shellius will use exists and is allowed to RDP."
exit 0
`;
  }

  return `# Shellius host bootstrap — Windows (OpenSSH server)
# Target host: ${hostname}
$ErrorActionPreference = 'Stop'

# Require elevation
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "This script must run as Administrator."
  exit 1
}

# Ensure OpenSSH Server is installed and running
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
  Write-Host "[shellius] Installing OpenSSH Server feature..."
  try {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
  } catch {
    Write-Error "Failed to install OpenSSH Server: $_"
    exit 1
  }
  Start-Service sshd
  Set-Service -Name sshd -StartupType 'Automatic'
}

$sshDir        = "$env:ProgramData\\ssh"
$caPubPath     = Join-Path $sshDir 'shellius_ca.pub'
$sshdConfig    = Join-Path $sshDir 'sshd_config'
$agentDir      = "$env:ProgramData\\Shellius"
$tokenPath     = Join-Path $agentDir 'agent-token'
$checkPsPath   = Join-Path $agentDir 'check-principals.ps1'

New-Item -ItemType Directory -Force -Path $sshDir   | Out-Null
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

$caPub = @'
${caPubKey}
'@
[System.IO.File]::WriteAllText($caPubPath, $caPub, [System.Text.UTF8Encoding]::new($false))

$agentToken = @'
${agentToken}
'@
[System.IO.File]::WriteAllText($tokenPath, $agentToken, [System.Text.UTF8Encoding]::new($false))

$checkScript = @"
param([string]\`$TargetUser, [string]\`$Serial)
try {
  \`$token = Get-Content -Raw -Path "\`$env:ProgramData\\Shellius\\agent-token"
  \`$body  = @{ serial = \`$Serial; principal = \`$TargetUser } | ConvertTo-Json -Compress
  \`$resp  = Invoke-RestMethod -Method Post -Uri "${apiUrl}/api/certificates/verify" -Headers @{ "x-agent-token" = \`$token.Trim() } -Body \`$body -ContentType "application/json" -TimeoutSec 5
  if (\`$resp.success -eq \`$true) { Write-Output \`$TargetUser }
} catch { }
"@
[System.IO.File]::WriteAllText($checkPsPath, $checkScript, [System.Text.UTF8Encoding]::new($false))

# Restrict ACLs on agent-token and CA pub to SYSTEM and Administrators
icacls $tokenPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
icacls $caPubPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:R" "Authenticated Users:R" | Out-Null

# Patch sshd_config idempotently
$markerStart = "# >>> shellius >>>"
$markerEnd   = "# <<< shellius <<<"
$block = @"
$markerStart
TrustedUserCAKeys $caPubPath
AuthorizedPrincipalsCommand powershell.exe -ExecutionPolicy Bypass -File "$checkPsPath" %u %s
AuthorizedPrincipalsCommandUser SYSTEM
$markerEnd
"@

if (Test-Path $sshdConfig) {
  $content = Get-Content -Raw $sshdConfig
  $content = [regex]::Replace($content, "(?s)# >>> shellius >>>.*?# <<< shellius <<<\\r?\\n?", "")
  $content = $content.TrimEnd() + "\`r\`n" + $block + "\`r\`n"
  [System.IO.File]::WriteAllText($sshdConfig, $content, [System.Text.UTF8Encoding]::new($false))
} else {
  [System.IO.File]::WriteAllText($sshdConfig, $block + "\`r\`n", [System.Text.UTF8Encoding]::new($false))
}

Write-Host "[shellius] Restarting sshd..."
Restart-Service sshd

Write-Host "[shellius] [OK] Bootstrap complete for ${hostname}"
Write-Host "[shellius]   CA trust:     $caPubPath"
Write-Host "[shellius]   Check script: $checkPsPath"
`;
}


// ---------------------------------------------------------------------------
// POST /api/bootstrap/bulk-token
// ---------------------------------------------------------------------------

const bulkTokenSchema = Joi.object({
  serverIds: Joi.array().items(Joi.string()).min(1).max(200).required(),
  mode: Joi.string().valid(...INSTALL_MODES).default('posture'),
});

/**
 * One install command per host, in one call.
 *
 * The automatic path (POST /api/servers/bulk-install) needs a credential for
 * every host. Plenty of fleets have hosts with none stored — that is exactly
 * the case where installing one at a time never happens, so the manual path
 * needs a bulk form too: a list an operator can paste into a change window
 * or a config-management run.
 *
 * Every token is per host, single use, and expires with the same TTL as a
 * single one, which is the honest constraint and is reported back so the UI
 * can say so rather than handing out a list that quietly goes stale.
 */
router.post(
  '/bulk-token',
  authenticate,
  tenant,
  requirePermission('servers.onboard'),
  audit('bootstrap.link.created', 'Server'),
  asyncHandler(async (req, res) => {
    const { error, value } = bulkTokenSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.message);

    // Scope-filtered, exactly as the single-server route is: a token here is
    // a working `curl … | sudo bash` bound to that host's CA trust.
    const servers = await prisma.server.findMany({
      where: { id: { in: value.serverIds }, orgId: req.orgId, ...serverScopeWhere(req.scope) },
      select: { id: true, hostname: true, displayName: true, osType: true, protocol: true, sshUser: true },
      orderBy: { hostname: 'asc' },
    });
    if (servers.length === 0) throw new ApiError(404, 'No matching servers');

    // Once for the batch, not once per host.
    if (value.mode !== 'posture') {
      try {
        await caService.getPublicKey(req.orgId);
      } catch (err) {
        if (err?.statusCode === 404) await caService.generateCaKeyPair(req.orgId, 'default');
        else throw err;
      }
    }

    const base = getPublicBaseUrl(req);
    const items = [];
    const skipped = [];

    for (const server of servers) {
      // Windows and RDP-only hosts have no installer to hand out. Saying so
      // beats emitting a command that cannot work on that host.
      if (server.osType === 'windows') {
        skipped.push({ id: server.id, hostname: server.hostname, reason: 'windows' });
        continue;
      }
      if (server.protocol === 'rdp') {
        skipped.push({ id: server.id, hostname: server.hostname, reason: 'rdp_only' });
        continue;
      }
      const token = signBootstrapToken({ serverId: server.id, orgId: req.orgId, mode: value.mode });
      items.push({
        id: server.id,
        hostname: server.hostname,
        displayName: server.displayName,
        osType: server.osType || null,
        command: `curl -fsSL "${base}/api/bootstrap/install.sh?token=${token}" | sudo bash`,
      });
    }

    res.json({
      success: true,
      data: { mode: value.mode, expiresInSeconds: BOOTSTRAP_TTL_SECONDS, items, skipped },
    });
  })
);

// Exported for the shell-syntax test only: these builders emit bash from a
// JS template literal, which is a shape where a stray backtick or an
// unescaped $ produces a script that only fails on a real host.
export const __testBuilders = { buildUnixInstallScript, buildPostureOnlyInstallScript };

export default router;
