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
 *      shared secret, the check-principals script, and updates sshd_config.
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
import requireRole from '../middleware/rbac.js';
import config from '../config/index.js';
import prisma from '../config/db.js';
import * as caService from '../services/caService.js';

const router = express.Router();

const BOOTSTRAP_TTL_SECONDS = 30 * 60; // 30 min

function signBootstrapToken({ serverId, orgId }) {
  return jwt.sign(
    { kind: 'bootstrap', serverId, orgId },
    config.jwt.secret,
    { expiresIn: BOOTSTRAP_TTL_SECONDS }
  );
}

function verifyBootstrapToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  if (payload.kind !== 'bootstrap') throw new Error('Invalid token kind');
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

// ---------------------------------------------------------------------------
// POST /api/bootstrap/token — authenticated
// ---------------------------------------------------------------------------

const tokenSchema = Joi.object({ serverId: Joi.string().required() });

router.post(
  '/token',
  authenticate,
  tenant,
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req, res) => {
    const { error, value } = tokenSchema.validate(req.body);
    if (error) throw new ApiError(400, error.message);

    const server = await prisma.server.findFirst({
      where: { id: value.serverId, orgId: req.orgId },
      select: { id: true, hostname: true, osType: true, sshUser: true, protocol: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    if (!process.env.AGENT_SHARED_SECRET) {
      throw new ApiError(500, 'AGENT_SHARED_SECRET is not configured on the backend');
    }

    // Auto-provision the org's SSH CA on first bootstrap if missing — the
    // install script needs the CA public key baked in. Without this, the user
    // would have to manually visit /settings/ca first, which is bad UX.
    try {
      await caService.getPublicKey(req.orgId);
    } catch (err) {
      if (err?.statusCode === 404) {
        await caService.generateCaKeyPair(req.orgId, 'default');
      } else {
        throw err;
      }
    }

    const token = signBootstrapToken({ serverId: server.id, orgId: req.orgId });
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

    const server = await prisma.server.findFirst({
      where: { id: payload.serverId, orgId: payload.orgId },
      select: { hostname: true, sshUser: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    const caPubKey = await caService.getPublicKey(payload.orgId);
    const agentSecret = process.env.AGENT_SHARED_SECRET;
    if (!agentSecret) throw new ApiError(500, 'AGENT_SHARED_SECRET not configured');

    const apiUrl = getPublicBaseUrl(req);

    const script = buildUnixInstallScript({
      apiUrl,
      agentSecret,
      caPubKey: caPubKey.trim(),
      hostname: server.hostname,
      sshUser: server.sshUser || 'root',
      serverId: payload.serverId,
      orgId: payload.orgId,
    });

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

    const server = await prisma.server.findFirst({
      where: { id: payload.serverId, orgId: payload.orgId },
      select: { hostname: true, sshUser: true, protocol: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    const caPubKey = await caService.getPublicKey(payload.orgId);
    const agentSecret = process.env.AGENT_SHARED_SECRET;
    if (!agentSecret) throw new ApiError(500, 'AGENT_SHARED_SECRET not configured');

    const apiUrl = getPublicBaseUrl(req);

    const script = buildWindowsInstallScript({
      apiUrl,
      agentSecret,
      caPubKey: caPubKey.trim(),
      hostname: server.hostname,
      protocol: server.protocol,
    });

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

function signUninstallToken({ serverId, orgId }) {
  return jwt.sign(
    { kind: 'uninstall', serverId, orgId },
    config.jwt.secret,
    { expiresIn: UNINSTALL_TTL_SECONDS }
  );
}

function verifyUninstallToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  if (payload.kind !== 'uninstall') throw new Error('Invalid token kind');
  return payload;
}

router.post(
  '/uninstall-token',
  authenticate,
  tenant,
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req, res) => {
    const { error, value } = tokenSchema.validate(req.body);
    if (error) throw new ApiError(400, error.message);

    const server = await prisma.server.findFirst({
      where: { id: value.serverId, orgId: req.orgId },
      select: { id: true, hostname: true, protocol: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    const token = signUninstallToken({ serverId: server.id, orgId: req.orgId });
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

    const server = await prisma.server.findFirst({
      where: { id: payload.serverId, orgId: payload.orgId },
      select: { hostname: true },
    });
    if (!server) throw new ApiError(404, 'Server not found');

    const script = buildUnixUninstallScript({ hostname: server.hostname });

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

function buildUnixInstallScript({ apiUrl, agentSecret, caPubKey, hostname, sshUser, serverId, orgId }) {
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
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

UPGRADE_ONLY=0
for arg in "\$@"; do
  [ "\$arg" = "--upgrade" ] && UPGRADE_ONLY=1
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
AGENT_SECRET_B64='${Buffer.from(agentSecret + '\n', 'utf8').toString('base64')}'

# ---------------------------------------------------------------------------
# 0. Prerequisites — jq and acl tools (Linux only; skip on macOS)
# ---------------------------------------------------------------------------
if [ "$PLATFORM" = "linux" ] && [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [0/12] Installing prerequisites (jq, acl)"
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
  echo "[shellius] [1/12] Writing CA public key → $CA_PUB_PATH"
  install -d -m 755 "$SSH_DIR"
  echo "$CA_PUB_B64" | base64 -d > "$CA_PUB_PATH"
  chmod 644 "$CA_PUB_PATH"
  chown root:0 "$CA_PUB_PATH" 2>/dev/null || chown root:wheel "$CA_PUB_PATH" 2>/dev/null || true
else
  echo "[shellius] [1/12] Skipping CA public key (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 2. Agent token + directory perms
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [2/12] Writing agent shared secret → $AGENT_TOKEN_PATH"
  install -d "$AGENT_DIR"
  # Force mode 755 even if the directory existed from an earlier run.
  # 'install -d -m 755' only applies the mode on creation; a previously-created
  # 750 directory would silently block 'nobody' from chdir-ing in.
  chmod 755 "$AGENT_DIR"
  chown root:0 "$AGENT_DIR" 2>/dev/null || chown root:wheel "$AGENT_DIR" 2>/dev/null || true
  echo "$AGENT_SECRET_B64" | base64 -d > "$AGENT_TOKEN_PATH"
  # sshd's AuthorizedPrincipalsCommand MUST run as an unprivileged user
  # ('nobody') per OpenSSH security policy. The check-principals script reads
  # this token to call /api/certificates/verify, so it must be readable by that
  # user. The token only authorizes read-only cert verification — world-readable
  # on the host is an acceptable trade-off vs. complex per-distro group setups.
  chmod 644 "$AGENT_TOKEN_PATH"
  chown root:0 "$AGENT_TOKEN_PATH" 2>/dev/null || chown root:wheel "$AGENT_TOKEN_PATH" 2>/dev/null || true
else
  echo "[shellius] [2/12] Skipping agent token (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 3. JIT working directories
# ---------------------------------------------------------------------------
echo "[shellius] [3/12] Creating JIT runtime directories"
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
echo "[shellius] [4/12] Installing check-principals v2 → $CHECK_PRINCIPALS_PATH"
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
echo "[shellius] [5/12] Installing narrow sudoers drop-in for check-principals"
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
  echo "[shellius] [6/12] Configuring sshd"
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
  echo "[shellius] [6/12] Skipping sshd config (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 7. Reaper systemd units (Linux only)
# ---------------------------------------------------------------------------
echo "[shellius] [7/12] Installing JIT reaper systemd units"
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
echo "[shellius] [8/12] Installing heartbeat systemd timer"
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
echo "[shellius] [9/12] Installing logrotate drop-in"
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

# ---------------------------------------------------------------------------
# 10. Validate sshd config
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [10/12] Validating sshd configuration"
  if command -v sshd >/dev/null 2>&1; then
    sshd -t
  fi
else
  echo "[shellius] [10/12] Skipping sshd validation (--upgrade)"
fi

# ---------------------------------------------------------------------------
# 11. Reload sshd
# ---------------------------------------------------------------------------
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius] [11/12] Reloading sshd"
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
  echo "[shellius] [11/12] Skipping sshd reload (--upgrade; check-principals update is live immediately)"
fi

# ---------------------------------------------------------------------------
# 12. Self-test — fail loudly if anything is wrong
# ---------------------------------------------------------------------------
echo "[shellius] [12/12] Running self-test"
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
echo "[shellius]   Check script:      $CHECK_PRINCIPALS_PATH"
echo "[shellius]   JIT lease dir:     $JIT_DIR"
echo "[shellius]   JIT log:           $JIT_LOG"
if [ "$PLATFORM" = "linux" ]; then
  echo "[shellius]   Reaper timer:      shellius-jit-reap.timer (5 min)"
fi
if [ "\$UPGRADE_ONLY" = "0" ]; then
  echo "[shellius]   Login user:        ${sshUser}"
  echo "[shellius]   You can now Open Web Terminal in the Shellius UI."
fi
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
//   The exact "# >>> shellius >>> ... # <<< shellius <<<" block in
//     /etc/ssh/sshd_config — and ONLY between those markers
//
function buildUnixUninstallScript({ hostname }) {
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

REMOVED=()
TOUCHED_SSHD=0

# ---------------------------------------------------------------------------
# 1. Remove the drop-in (entirely Shellius-owned, safe to delete outright)
# ---------------------------------------------------------------------------
echo "[shellius] [1/6] Removing drop-in"
if [ -f "$SSHD_DROPIN" ]; then
  rm -f "$SSHD_DROPIN"
  REMOVED+=("$SSHD_DROPIN")
fi

# ---------------------------------------------------------------------------
# 2. Strip the inline shellius block from sshd_config (between markers ONLY)
#    Backup first, edit second, validate third, reload fourth.
# ---------------------------------------------------------------------------
echo "[shellius] [2/6] Stripping inline block from sshd_config (if any)"
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
echo "[shellius] [3/6] Removing CA public key"
if [ -f "$CA_PUB" ]; then
  rm -f "$CA_PUB"
  REMOVED+=("$CA_PUB")
fi

# ---------------------------------------------------------------------------
# 4. Remove agent token + directory (only if directory is empty)
# ---------------------------------------------------------------------------
echo "[shellius] [4/6] Removing agent token"
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
echo "[shellius] [5/6] Removing check-principals script"
if [ -f "$CHECK_SCRIPT" ]; then
  rm -f "$CHECK_SCRIPT"
  REMOVED+=("$CHECK_SCRIPT")
fi

# ---------------------------------------------------------------------------
# 6. Validate sshd config and reload — refuses if validation fails
# ---------------------------------------------------------------------------
echo "[shellius] [6/6] Validating sshd config"
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

function buildWindowsInstallScript({ apiUrl, agentSecret, caPubKey, hostname, protocol }) {
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
${agentSecret}
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

export default router;
