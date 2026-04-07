# Task 17C: Bootstrap Uninstaller (script + UI + safety)

**Agent:** backend + frontend
**Status:** [x] Done
**Blocks:** 17Q-C, 17R-C
**Blocked By:** None
**Model:** sonnet

## Objective
Reverse what the install script did, without touching anything else
on the host. Operator might be removing a server from Shellius but
keeping the host alive — uninstaller must be safe.

## Backend
- New route in `backend/src/routes/bootstrap.js`:
  `GET /api/bootstrap/uninstall.sh?token=<jwt>` (token from the same
  `signBootstrapToken` flow used for install)
- New `POST /api/bootstrap/uninstall-token` endpoint mirroring the
  existing install-token endpoint. Returns
  `{ commands: { linux, macos } }`.
- Builder function `buildUnixUninstallScript(...)` in bootstrap.js.

## Uninstall script behavior

```
#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root" >&2; exit 1
fi

CA_PUB=/etc/ssh/shellius_ca.pub
AGENT_DIR=/etc/shellius
TOKEN_PATH=$AGENT_DIR/agent-token
CHECK_SCRIPT=/usr/local/sbin/shellius-check-principals
SSHD_CONFIG=/etc/ssh/sshd_config
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-shellius.conf

REMOVED=()

# 1) Remove drop-in (safe — entirely Shellius-owned)
if [ -f "$SSHD_DROPIN" ]; then
  rm -f "$SSHD_DROPIN"
  REMOVED+=("$SSHD_DROPIN")
fi

# 2) Remove inline shellius block from sshd_config (safe — only between markers)
if grep -q '^# >>> shellius >>>' "$SSHD_CONFIG"; then
  cp "$SSHD_CONFIG" "$SSHD_CONFIG.shellius.bak"
  sed -i '/^# >>> shellius >>>/,/^# <<< shellius <<</d' "$SSHD_CONFIG"
  REMOVED+=("$SSHD_CONFIG (inline block; backup at $SSHD_CONFIG.shellius.bak)")
fi

# 3) Remove CA pub
[ -f "$CA_PUB" ] && rm -f "$CA_PUB" && REMOVED+=("$CA_PUB")

# 4) Remove agent token + dir
[ -f "$TOKEN_PATH" ] && rm -f "$TOKEN_PATH" && REMOVED+=("$TOKEN_PATH")
[ -d "$AGENT_DIR" ] && rmdir "$AGENT_DIR" 2>/dev/null && REMOVED+=("$AGENT_DIR")

# 5) Remove check-principals script
[ -f "$CHECK_SCRIPT" ] && rm -f "$CHECK_SCRIPT" && REMOVED+=("$CHECK_SCRIPT")

# 6) CRITICAL: validate sshd config BEFORE reload. If invalid, restore the backup.
if ! sshd -t 2>/dev/null; then
  echo "ERROR: sshd -t failed after uninstall. Restoring backup."
  if [ -f "$SSHD_CONFIG.shellius.bak" ]; then
    cp "$SSHD_CONFIG.shellius.bak" "$SSHD_CONFIG"
  fi
  exit 1
fi

# 7) Reload sshd
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || \
  service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || true

# 8) Self-test: confirm sshd no longer trusts us
if sshd -T 2>/dev/null | grep -q "trustedusercakeys $CA_PUB"; then
  echo "WARN: sshd still references $CA_PUB — manual cleanup needed"
fi

echo "[shellius] Uninstall complete. Removed:"
for f in "${REMOVED[@]}"; do echo "  - $f"; done
echo "[shellius] sshd_config backup (if needed): $SSHD_CONFIG.shellius.bak"
echo "[shellius] Other SSH config / authorized_keys / host keys: untouched."
```

**SAFETY** (the user explicitly asked for this — DO NOT regress):
- NEVER touch `authorized_keys` (any path)
- NEVER touch `/etc/ssh/ssh_host_*`
- NEVER touch `/etc/ssh/ssh_known_hosts`
- NEVER touch any other `Include` directive or unrelated drop-in
- NEVER touch `/root/.ssh/` or any user's `~/.ssh/`
- ALWAYS backup `sshd_config` before any sed edit
- ALWAYS run `sshd -t` BEFORE the systemd reload, and refuse to reload
  if the test fails (restoring the backup)

## Frontend
- New `frontend/src/components/servers/UninstallHostModal.jsx`
  mirroring `BootstrapModal.jsx`:
  - Header: "Uninstall Shellius Agent from <hostname>"
  - Body: warning copy explaining what will be removed and what is
    untouched, then the OS-tabbed copy/paste one-liner
  - Footer: Done button
- Add a "Uninstall Shellius Agent" item to the Servers row menu
  (icon: `Eraser` or `Trash2`) AND to the ServerDetail action bar.
- New service method `bootstrapService.createUninstallToken(serverId)`.

## Acceptance
- Uninstaller cleanly removes every file the installer added.
- The script REFUSES to leave the host with a broken sshd config.
- No file outside the `# >>> shellius >>>` block in `sshd_config` is
  touched.
- After uninstall + reload, normal SSH (with a regular authorized_keys
  setup) still works on the host — this is verified by the manual
  smoke step.
