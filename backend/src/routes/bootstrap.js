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
  requireRole('admin'),
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
// Script generators
// ---------------------------------------------------------------------------

function shEscape(value) {
  // Safe for single-quoted heredoc delimiters — we avoid embedding user input
  // into shell strings directly. Only used for predictable identifiers.
  return String(value).replace(/'/g, "'\\''");
}

function buildUnixInstallScript({ apiUrl, agentSecret, caPubKey, hostname, sshUser }) {
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
  return `#!/usr/bin/env bash
# Shellius host bootstrap — installs CA trust and check-principals agent.
# Target host: ${hostname}
# Idempotent: safe to re-run. Self-tests at the end and exits non-zero if
# anything is misconfigured.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

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

SSH_DIR=/etc/ssh
CA_PUB_PATH="$SSH_DIR/shellius_ca.pub"
AGENT_DIR=/etc/shellius
AGENT_TOKEN_PATH="$AGENT_DIR/agent-token"
CHECK_PRINCIPALS_PATH=/usr/local/sbin/shellius-check-principals
SSHD_CONFIG="$SSH_DIR/sshd_config"
SSHD_DROPIN="$SSH_DIR/sshd_config.d/99-shellius.conf"

# Encoded payloads — base64 to bypass heredoc/quoting hazards entirely.
CA_PUB_B64='${Buffer.from(caPubKey + '\n', 'utf8').toString('base64')}'
AGENT_SECRET_B64='${Buffer.from(agentSecret + '\n', 'utf8').toString('base64')}'

# ---------------------------------------------------------------------------
# 1. CA public key
# ---------------------------------------------------------------------------
echo "[shellius] [1/8] Writing CA public key → $CA_PUB_PATH"
install -d -m 755 "$SSH_DIR"
echo "$CA_PUB_B64" | base64 -d > "$CA_PUB_PATH"
chmod 644 "$CA_PUB_PATH"
chown root:0 "$CA_PUB_PATH" 2>/dev/null || chown root:wheel "$CA_PUB_PATH" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Agent token + directory perms
# ---------------------------------------------------------------------------
echo "[shellius] [2/8] Writing agent shared secret → $AGENT_TOKEN_PATH"
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

# ---------------------------------------------------------------------------
# 3. check-principals script
# ---------------------------------------------------------------------------
echo "[shellius] [3/8] Installing check-principals script → $CHECK_PRINCIPALS_PATH"
install -d -m 755 /usr/local/sbin
# Build the check-principals script via printf — no heredocs.
{
  printf '%s\\n' '#!/usr/bin/env bash'
  printf '%s\\n' '# Shellius check-principals — called by sshd AuthorizedPrincipalsCommand.'
  printf '%s\\n' '# Args: %u (target user) %s (cert serial) %k (cert key fingerprint) %i (cert key id)'
  printf '%s\\n' '# Logs every invocation to syslog. Inspect with:'
  printf '%s\\n' '#   sudo journalctl -t shellius-check-principals -n 30'
  printf '%s\\n' 'set -euo pipefail'
  printf '%s\\n' 'TARGET_USER="\${1:-}"'
  printf '%s\\n' 'SERIAL="\${2:-}"'
  printf '%s\\n' 'PRINCIPAL="\$TARGET_USER"'
  printf 'API_URL=%s\\n' "'${apiUrl}'"
  printf '%s\\n' 'TOKEN_FILE=/etc/shellius/agent-token'
  printf '%s\\n' 'log() { logger -t shellius-check-principals "\$1" 2>/dev/null || true; }'
  printf '%s\\n' 'if [ ! -r "\$TOKEN_FILE" ]; then'
  printf '%s\\n' '  log "FAIL token file unreadable as \$(id -un): \$TOKEN_FILE"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' 'TOKEN="\$(cat "\$TOKEN_FILE")"'
  printf '%s\\n' 'if [ -z "\$TOKEN" ]; then log "FAIL token file empty"; exit 0; fi'
  printf '%s\\n' 'BODY="{\\"serial\\":\\"\$SERIAL\\",\\"principal\\":\\"\$PRINCIPAL\\"}"'
  printf '%s\\n' 'RESP="\$(curl -fsS --max-time 5 -H "x-agent-token: \$TOKEN" -H "Content-Type: application/json" -d "\$BODY" "\$API_URL/api/certificates/verify" 2>&1 || echo "CURL_ERROR:\$?")"'
  printf '%s\\n' 'if echo "\$RESP" | grep -q "^CURL_ERROR"; then'
  printf '%s\\n' '  log "FAIL curl to \$API_URL: \$RESP"'
  printf '%s\\n' '  exit 0'
  printf '%s\\n' 'fi'
  printf '%s\\n' 'if echo "\$RESP" | grep -q "\\"success\\":true"; then'
  printf '%s\\n' '  log "OK user=\$TARGET_USER serial=\$SERIAL"'
  printf '%s\\n' '  echo "\$PRINCIPAL"'
  printf '%s\\n' 'else'
  printf '%s\\n' '  log "DENY user=\$TARGET_USER serial=\$SERIAL resp=\$(echo "\$RESP" | head -c 200)"'
  printf '%s\\n' 'fi'
  printf '%s\\n' 'exit 0'
} > "$CHECK_PRINCIPALS_PATH"
chmod 755 "$CHECK_PRINCIPALS_PATH"
chown root:0 "$CHECK_PRINCIPALS_PATH" 2>/dev/null || chown root:wheel "$CHECK_PRINCIPALS_PATH" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. sshd config (drop-in if Includes; else in-place with markers)
# ---------------------------------------------------------------------------
echo "[shellius] [4/8] Configuring sshd"
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
    printf 'AuthorizedPrincipalsCommand %s %%u %%s\\n' "$CHECK_PRINCIPALS_PATH"
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
      print "AuthorizedPrincipalsCommand " cp " %u %s"
      print "AuthorizedPrincipalsCommandUser nobody"
      print "# <<< shellius <<<"
      inserted = 1
    }
    { print }
    END {
      if (!inserted) {
        print "# >>> shellius >>>"
        print "TrustedUserCAKeys " ca
        print "AuthorizedPrincipalsCommand " cp " %u %s"
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

# ---------------------------------------------------------------------------
# 5. Validate config
# ---------------------------------------------------------------------------
echo "[shellius] [5/8] Validating sshd configuration"
if command -v sshd >/dev/null 2>&1; then
  sshd -t
fi

# ---------------------------------------------------------------------------
# 6. Reload sshd
# ---------------------------------------------------------------------------
echo "[shellius] [6/8] Reloading sshd"
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
# 7. Self-test — fail loudly if anything is wrong
# ---------------------------------------------------------------------------
echo "[shellius] [7/8] Running self-test"
SELF_TEST_FAIL=0

# 7a. sshd's effective config must include our directives
if command -v sshd >/dev/null 2>&1 && sshd -T >/dev/null 2>&1; then
  TRUST_LINE="\$(sshd -T 2>/dev/null | grep -i '^trustedusercakeys ' || true)"
  PRINC_LINE="\$(sshd -T 2>/dev/null | grep -i '^authorizedprincipalscommand ' || true)"
  PRINC_USER_LINE="\$(sshd -T 2>/dev/null | grep -i '^authorizedprincipalscommanduser ' || true)"

  if echo "\$TRUST_LINE" | grep -qi "$CA_PUB_PATH"; then
    echo "[shellius]   ✓ sshd trusts $CA_PUB_PATH"
  else
    echo "[shellius]   ✗ TrustedUserCAKeys not effective. sshd -T shows: \${TRUST_LINE:-(missing)}"
    SELF_TEST_FAIL=1
  fi
  if echo "\$PRINC_LINE" | grep -qi "$CHECK_PRINCIPALS_PATH"; then
    echo "[shellius]   ✓ sshd has AuthorizedPrincipalsCommand"
  else
    echo "[shellius]   ✗ AuthorizedPrincipalsCommand not effective. sshd -T shows: \${PRINC_LINE:-(missing or 'none')}"
    echo "[shellius]     This usually means sshd rejected an unsupported %-token."
    echo "[shellius]     Check the line in /etc/ssh/sshd_config and validate with: sudo sshd -t -f /etc/ssh/sshd_config"
    SELF_TEST_FAIL=1
  fi
  if echo "\$PRINC_USER_LINE" | grep -qi 'nobody'; then
    echo "[shellius]   ✓ sshd has AuthorizedPrincipalsCommandUser=nobody"
  else
    echo "[shellius]   ✗ AuthorizedPrincipalsCommandUser not effective. sshd -T shows: \${PRINC_USER_LINE:-(missing)}"
    SELF_TEST_FAIL=1
  fi
else
  echo "[shellius]   ! sshd -T unavailable; skipping effective-config check"
fi

# 7b. 'nobody' must be able to read the agent token
if id nobody >/dev/null 2>&1; then
  if sudo -u nobody cat "$AGENT_TOKEN_PATH" >/dev/null 2>&1; then
    echo "[shellius]   ✓ 'nobody' can read $AGENT_TOKEN_PATH"
  else
    echo "[shellius]   ✗ 'nobody' CANNOT read $AGENT_TOKEN_PATH (dir or file perms wrong)"
    ls -ld "$AGENT_DIR" "$AGENT_TOKEN_PATH" >&2
    SELF_TEST_FAIL=1
  fi
else
  echo "[shellius]   ! 'nobody' user does not exist; skipping token-read check"
fi

# 7c. check-principals manual invocation as nobody must run cleanly
if id nobody >/dev/null 2>&1; then
  if sudo -u nobody "$CHECK_PRINCIPALS_PATH" "${sshUser}" testserial testkey testid >/dev/null 2>&1; then
    echo "[shellius]   ✓ check-principals runs as 'nobody' (test invocation)"
  else
    echo "[shellius]   ✗ check-principals failed when run as 'nobody' (exit \$?)"
    SELF_TEST_FAIL=1
  fi
fi

# 7d. CA fingerprint sanity check
if command -v ssh-keygen >/dev/null 2>&1; then
  echo "[shellius]   CA fingerprint: $(ssh-keygen -lf "$CA_PUB_PATH" 2>/dev/null | awk '{print $2}')"
fi

# 7e. local user sanity check
if id "${sshUser}" >/dev/null 2>&1; then
  echo "[shellius]   ✓ local user '${sshUser}' exists"
else
  echo "[shellius]   ! local user '${sshUser}' does NOT exist on this host."
  echo "[shellius]     Create it with: sudo useradd -m -s /bin/bash ${sshUser}"
  echo "[shellius]     (not a fatal error — but SSH cert auth will fail until the user exists)"
fi

if [ "$SELF_TEST_FAIL" -ne 0 ]; then
  echo "[shellius] ✗ Self-test FAILED. Inspect the messages above."
  echo "[shellius]   Quick diagnostics:"
  echo "[shellius]     sudo sshd -T | grep -iE 'trustedusercakeys|authorizedprincipals'"
  echo "[shellius]     sudo journalctl -t shellius-check-principals -n 30 --no-pager"
  echo "[shellius]     sudo journalctl -u ssh -n 30 --no-pager"
  exit 1
fi

# ---------------------------------------------------------------------------
# 8. Done
# ---------------------------------------------------------------------------
echo "[shellius] [8/8] ✓ Bootstrap complete."
echo "[shellius]   Host:         ${hostname}"
echo "[shellius]   CA trust:     $CA_PUB_PATH"
echo "[shellius]   Check script: $CHECK_PRINCIPALS_PATH"
echo "[shellius]   Login user:   ${sshUser}"
echo "[shellius]   You can now Open Web Terminal in the Shellius UI."
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

Write-Host "[shellius] ✓ Bootstrap complete for ${hostname}"
Write-Host "[shellius]   CA trust:     $caPubPath"
Write-Host "[shellius]   Check script: $checkPsPath"
`;
}

export default router;
