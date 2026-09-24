#!/usr/bin/env bash
#
# shellius-collector-update — pull, verify and install a newer posture
# collector, and put the old one back if the new one does not work.
#
# Invoked by shellius-collector-update.timer, as root, every 15 minutes with
# a randomised delay. See docs/collector-updates.md.
#
# WHAT THIS IS, STATED PLAINLY
#
#   This script downloads code from the Shellius server and runs it as root.
#   That is the feature. Everything below exists to make that specific
#   sentence safe to say out loud:
#
#     * It only ever writes ONE path: /usr/local/sbin/shellius-posture-collect.
#       Not sshd config, not the CA, not check-principals, not the heartbeat.
#       A bad collector makes posture go quiet; a bad check-principals decides
#       whether anyone can log in anywhere, so check-principals is not
#       updatable this way at all.
#     * The server names the version; the bytes must match a SHA-256 the
#       server also names, AND carry a valid signature from the Shellius
#       installation's own key, whose public half was written to this host at
#       bootstrap time. TLS says "these bytes came from whatever answers at
#       that hostname". The signature says "these bytes came from that
#       installation's key and nobody has changed them since" — which still
#       holds through a proxy, a mirror, or a TLS-terminating middlebox.
#     * Verification failure is a REFUSAL, never a fallback. There is no code
#       path here that installs unverified bytes.
#     * The replaced collector is kept, the new one is run once before it is
#       trusted, and it is put back if that run fails.
#
# It is deliberately inert on failure: every error path leaves the host
# exactly as it was, logs a line, and exits 0. The one thing this script must
# never do is leave a host without a working collector.
#
# Usage: shellius-collector-update [--api-url URL] [--token-file PATH]
#                                  [--key-file PATH] [--dry-run]

set -uo pipefail

API_URL="__SHELLIUS_POSTURE_API_URL__"
TOKEN_FILE="/etc/shellius/agent-token"
KEY_FILE="/etc/shellius/release-key.pub"
COLLECTOR="/usr/local/sbin/shellius-posture-collect"
PREVIOUS="/usr/local/sbin/shellius-posture-collect.prev"
COLLECTOR_USER="shellius-posture"
LOG_TAG="shellius-collector-update"

CURL_TIMEOUT=30
# A collector run is a few seconds; ten times that is a hung one.
SMOKE_TIMEOUT=60
# The collector script is tens of kilobytes. A response far larger than that
# is not a collector, and is refused before it is written anywhere.
MAX_SCRIPT_BYTES=1048576

DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --key-file) KEY_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() { logger -t "$LOG_TAG" "$1" 2>/dev/null || true; [ "$DRY_RUN" = 1 ] && echo "$1"; return 0; }

WORKDIR="$(mktemp -d)" || { log "FAIL cannot create temp dir"; exit 0; }
chmod 700 "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

# --- preconditions -----------------------------------------------------------
# Every one of these is "leave the host alone", never "carry on regardless".

for tool in curl openssl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { log "SKIP $tool is not installed"; exit 0; }
done

if [ ! -r "$TOKEN_FILE" ]; then
  log "SKIP agent token unreadable: $TOKEN_FILE"
  exit 0
fi
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
[ -n "$TOKEN" ] || { log "SKIP agent token file is empty"; exit 0; }

# No key, no updates. This is the line that makes "verification failure is a
# refusal" true even for a host that was somehow installed without a key.
if [ ! -r "$KEY_FILE" ]; then
  log "SKIP no release signing key at $KEY_FILE — refusing to install unverified code"
  exit 0
fi

# --- is anything offered? ----------------------------------------------------

OFFER="$(curl -fsS --max-time "$CURL_TIMEOUT" \
  -H "x-agent-token: $TOKEN" \
  "$API_URL/api/hosts/collector-update" 2>"$WORKDIR/curl.err")"
if [ $? -ne 0 ]; then
  log "SKIP could not ask for an update: $(tail -c 200 "$WORKDIR/curl.err" 2>/dev/null)"
  exit 0
fi

# The payload is small, flat and entirely server-controlled, so a field-by-
# field extraction is enough and avoids depending on jq or python3 being
# installed. Anything that does not match leaves the variable empty, and every
# use below is guarded.
field() { printf '%s' "$OFFER" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

VERSION="$(field version)"
SHA_EXPECTED="$(field sha256)"
SIGNATURE="$(field signature)"

if [ -z "$VERSION" ]; then
  log "OK no update offered"
  exit 0
fi

if [ -z "$SHA_EXPECTED" ] || [ -z "$SIGNATURE" ]; then
  log "FAIL update $VERSION offered without a digest or signature — refusing"
  exit 0
fi

# Never install what is already installed: a loop that reinstalls the same
# version every fifteen minutes would restart the collector timer forever.
if [ -x "$COLLECTOR" ]; then
  CURRENT="$(sed -n 's/^VERSION="\([^"]*\)".*/\1/p' "$COLLECTOR" 2>/dev/null | head -1)"
  if [ "$CURRENT" = "$VERSION" ]; then
    log "OK already on $VERSION"
    exit 0
  fi
fi

log "INFO update offered: ${CURRENT:-unknown} -> $VERSION"

# --- fetch -------------------------------------------------------------------

if ! curl -fsS --max-time "$CURL_TIMEOUT" \
      --max-filesize "$MAX_SCRIPT_BYTES" \
      -H "x-agent-token: $TOKEN" \
      -o "$WORKDIR/collector" \
      "$API_URL/api/hosts/collector-script" 2>"$WORKDIR/curl.err"; then
  log "FAIL could not download the collector: $(tail -c 200 "$WORKDIR/curl.err" 2>/dev/null)"
  exit 0
fi

if [ ! -s "$WORKDIR/collector" ]; then
  log "FAIL downloaded collector is empty"
  exit 0
fi

# --- verify ------------------------------------------------------------------
# Digest first because it is cheap and catches a truncated download; the
# signature is the one that actually matters.

SHA_ACTUAL="$(sha256sum "$WORKDIR/collector" | awk '{print $1}')"
if [ "$SHA_ACTUAL" != "$SHA_EXPECTED" ]; then
  log "FAIL digest mismatch for $VERSION (expected $SHA_EXPECTED, got $SHA_ACTUAL) — refusing"
  exit 0
fi

printf '%s' "$SIGNATURE" | openssl base64 -d -A >"$WORKDIR/collector.sig" 2>/dev/null || {
  log "FAIL signature is not valid base64 — refusing"
  exit 0
}

# RSA PKCS#1 v1.5 over SHA-256 — see backend/src/services/releaseSigningService.js
# for why RSA and not Ed25519 (this verifier has to work on OpenSSL 1.0.2).
if ! openssl dgst -sha256 -verify "$KEY_FILE" \
      -signature "$WORKDIR/collector.sig" "$WORKDIR/collector" >/dev/null 2>&1; then
  log "FAIL signature does not verify against $KEY_FILE — refusing to install $VERSION"
  exit 0
fi

# Belt and braces: a verified file that is not a shell script means something
# has gone wrong in a way the signature cannot describe.
head -1 "$WORKDIR/collector" | grep -q '^#!' || {
  log "FAIL downloaded collector does not start with a shebang — refusing"
  exit 0
}

log "INFO $VERSION verified (sha256 + signature)"

if [ "$DRY_RUN" = 1 ]; then
  log "OK dry run — verified $VERSION, not installing"
  exit 0
fi

# --- install -----------------------------------------------------------------

install -m 0755 -o root -g root "$WORKDIR/collector" "$WORKDIR/collector.staged" || {
  log "FAIL could not stage the new collector"
  exit 0
}

# Keep the outgoing one. This is what makes the rollback below possible, and
# it is taken BEFORE anything is replaced.
if [ -x "$COLLECTOR" ]; then
  cp -p "$COLLECTOR" "$PREVIOUS" 2>/dev/null || {
    log "FAIL could not keep a copy of the current collector — not installing"
    exit 0
  }
fi

# Same filesystem, so this is atomic: no window in which the collector is
# half-written, and no window in which it does not exist at all.
if ! mv -f "$WORKDIR/collector.staged" "$COLLECTOR"; then
  log "FAIL could not replace the collector"
  exit 0
fi
chmod 0755 "$COLLECTOR" 2>/dev/null || true

# --- prove it works, or put the old one back ---------------------------------
#
# The collector runs as an unprivileged account and reaches root only through
# a narrow sudoers grant, so it is run HERE as that same account: running it
# as root would prove nothing about whether it works in the context it
# actually runs in.

SMOKE_OK=0
if id "$COLLECTOR_USER" >/dev/null 2>&1; then
  if timeout "$SMOKE_TIMEOUT" runuser -u "$COLLECTOR_USER" -- "$COLLECTOR" >"$WORKDIR/smoke.out" 2>"$WORKDIR/smoke.err"; then
    # Exit 0 is not enough: the collector's contract is a single JSON object
    # on stdout, and something that exits 0 printing nothing is broken in a
    # way the reporter would report as "collector produced no output".
    if [ -s "$WORKDIR/smoke.out" ] && head -c 1 "$WORKDIR/smoke.out" | grep -q '{'; then
      SMOKE_OK=1
    else
      log "WARN new collector exited 0 but produced no JSON"
    fi
  else
    log "WARN new collector failed its smoke run: $(tail -c 300 "$WORKDIR/smoke.err" 2>/dev/null)"
  fi
else
  # No collector account means this host was never set up for posture; there
  # is nothing to smoke-test against and nothing that would have been running.
  log "WARN collector account $COLLECTOR_USER is missing — installing without a smoke test"
  SMOKE_OK=1
fi

if [ "$SMOKE_OK" != 1 ]; then
  if [ -x "$PREVIOUS" ]; then
    mv -f "$PREVIOUS" "$COLLECTOR" && chmod 0755 "$COLLECTOR" 2>/dev/null
    log "FAIL rolled back to the previous collector after $VERSION failed its smoke run"
  else
    log "FAIL $VERSION failed its smoke run and there is no previous collector to restore"
  fi
  # The server notices too: the host carries on reporting the old version,
  # and the rollout halts rather than widening. See docs/collector-updates.md.
  exit 0
fi

# --- settle ------------------------------------------------------------------
# Restart the timer so the next run picks up the new script promptly. Failing
# to restart is not fatal: the timer fires again on its own schedule anyway.

if command -v systemctl >/dev/null 2>&1; then
  systemctl restart shellius-posture.timer >/dev/null 2>&1 || true
fi

log "OK installed collector $VERSION (previous kept at $PREVIOUS)"
exit 0
