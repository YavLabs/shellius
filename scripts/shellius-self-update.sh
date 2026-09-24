#!/usr/bin/env bash
#
# shellius-self-update — the host-side half of "update Shellius from the UI".
#
# Installed deliberately by an operator (see docs/instance-updates.md). Without
# it, an update requested in the web UI simply sits there and the UI shows the
# command to run by hand — which is the default, and a perfectly good end state.
#
# WHY THIS IS A SEPARATE SCRIPT AND NOT A FEATURE OF THE APP
#
#   A container cannot reliably replace itself. The two obvious workarounds —
#   mounting the Docker socket into the application, or giving the application
#   a shell on its host — both hand the web app root on the machine holding
#   the SSH CA. For a product whose pitch is the elimination of standing
#   privilege, that is not a trade worth making for the convenience of a
#   button.
#
#   So the privileged half is this: a short script an operator read and chose
#   to install, which polls the API for an intent and runs the existing
#   update-shellius.sh. The application's capability stops at "record a row".
#
# WHAT IT REFUSES
#
#   * Any version that is not plain semver.
#   * Any version that is not NEWER than what is running. If the app were
#     compromised, the most useful thing an attacker could ask for through
#     this channel is a downgrade to a published release with a known
#     vulnerability. The API refuses that too; this refuses it independently,
#     because a control that exists in only one of two places is one bug away
#     from not existing.
#   * Anything at all, if update-shellius.sh is not where it expects.
#
# It never force-updates, never skips the backup that update-shellius.sh takes,
# and reports what happened back to the API so the UI can show it.
#
# Usage: shellius-self-update [--api-url URL] [--token-file PATH]
#                             [--app-dir PATH] [--once] [--dry-run]

set -uo pipefail

VERSION="1.0.0"

API_URL="${SHELLIUS_API_URL:-}"
TOKEN_FILE="${SHELLIUS_TOKEN_FILE:-/etc/shellius/self-update-token}"
APP_DIR="${SHELLIUS_APP_DIR:-$HOME/shellius}"
UPDATE_SCRIPT=""
LOG_TAG="shellius-self-update"
CURL_TIMEOUT=20
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --once) shift ;;   # accepted for symmetry; this script is always one-shot
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() {
  logger -t "$LOG_TAG" "$1" 2>/dev/null || true
  echo "[$LOG_TAG] $1"
}

[ -n "$API_URL" ] || { log "SKIP no API URL configured (set SHELLIUS_API_URL)"; exit 0; }

for tool in curl; do
  command -v "$tool" >/dev/null 2>&1 || { log "SKIP $tool is not installed"; exit 0; }
done

if [ ! -r "$TOKEN_FILE" ]; then
  log "SKIP token unreadable at $TOKEN_FILE"
  exit 0
fi
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
[ -n "$TOKEN" ] || { log "SKIP token file is empty"; exit 0; }

UPDATE_SCRIPT="$APP_DIR/scripts/update-shellius.sh"
if [ ! -f "$UPDATE_SCRIPT" ]; then
  log "SKIP $UPDATE_SCRIPT not found — nothing this helper can run"
  exit 0
fi

CURRENT="unknown"
[ -f "$APP_DIR/VERSION" ] && CURRENT="$(tr -d '[:space:]' <"$APP_DIR/VERSION")"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS --max-time "$CURL_TIMEOUT" -X "$method" \
      -H "x-shellius-helper-token: $TOKEN" -H "Content-Type: application/json" \
      --data-binary "$body" "$API_URL$path" 2>/dev/null
  else
    curl -fsS --max-time "$CURL_TIMEOUT" -X "$method" \
      -H "x-shellius-helper-token: $TOKEN" "$API_URL$path" 2>/dev/null
  fi
}

field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1; }

# --- is anything requested? --------------------------------------------------

POLL_BODY="{\"helperVersion\":\"$VERSION\",\"hostname\":\"$(hostname 2>/dev/null || echo unknown)\"}"
RESPONSE="$(api POST /api/updates/helper/poll "$POLL_BODY")" || {
  log "SKIP could not reach $API_URL"
  exit 0
}

REQUEST_ID="$(field "$RESPONSE" id)"
TARGET="$(field "$RESPONSE" targetVersion)"

if [ -z "$REQUEST_ID" ] || [ -z "$TARGET" ]; then
  log "OK nothing requested (running $CURRENT)"
  exit 0
fi

# --- refuse what should not be run -------------------------------------------

# Deliberately the SAME grammar as instanceUpdateService.normalizeVersion: a
# pre-release suffix must begin with a hyphen. The looser version accepted
# things the API would have rejected, which quietly made the two "independent"
# refusals test different policies.
if ! printf '%s' "$TARGET" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[-.0-9A-Za-z]+)?$'; then
  log "FAIL refusing '$TARGET' — not a plain semver version"
  api POST "/api/updates/helper/status/$REQUEST_ID" \
    "{\"status\":\"failed\",\"detail\":\"The helper refused '$TARGET': not a plain semver version.\"}" >/dev/null
  exit 0
fi

# The downgrade refusal, enforced here as well as in the API.
newest() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }
if [ "$CURRENT" != "unknown" ]; then
  if [ "$TARGET" = "$CURRENT" ] || [ "$(newest "$TARGET" "$CURRENT")" != "$TARGET" ]; then
    log "FAIL refusing $TARGET — not newer than the running version ($CURRENT)"
    api POST "/api/updates/helper/status/$REQUEST_ID" \
      "{\"status\":\"failed\",\"detail\":\"The helper refused $TARGET: it is not newer than the running version ($CURRENT). Downgrades are done on the host with ./update-shellius.sh --rollback.\"}" >/dev/null
    exit 0
  fi
fi

log "INFO update requested: $CURRENT -> $TARGET"

if [ "$DRY_RUN" = 1 ]; then
  log "OK dry run — would upgrade to $TARGET"
  exit 0
fi

# --- claim it ----------------------------------------------------------------
#
# The claim is what stops two helpers (or one helper whose previous run has not
# finished) starting two upgrades on the same host. The API only lets the
# claim succeed once.

CLAIM="$(api POST "/api/updates/helper/claim/$REQUEST_ID")" || {
  log "SKIP could not claim $REQUEST_ID — another helper may have taken it"
  exit 0
}

api POST "/api/updates/helper/status/$REQUEST_ID" \
  "{\"status\":\"running\",\"detail\":\"Upgrading $CURRENT to $TARGET on $(hostname 2>/dev/null || echo host).\"}" >/dev/null

# --- run it ------------------------------------------------------------------
#
# update-shellius.sh does the real work and already does it carefully: it
# backs up the database and the code before it touches anything, builds the
# new images while the old ones keep serving, runs the migrations, and only
# then swaps and restarts. Nothing is reimplemented here — this only decides
# WHEN it runs, never HOW.
#
# --yes because there is no terminal to confirm at. That is precisely why the
# refusals above are in this script and not left to the prompt.

LOGFILE="$(mktemp -t shellius-self-update-XXXXXX.log)"
log "INFO running update-shellius.sh $TARGET (log: $LOGFILE)"

if bash "$UPDATE_SCRIPT" "$TARGET" --yes >"$LOGFILE" 2>&1; then
  NEW="unknown"
  [ -f "$APP_DIR/VERSION" ] && NEW="$(tr -d '[:space:]' <"$APP_DIR/VERSION")"
  log "OK upgraded to $NEW"
  # The API this reports to is the one that was just restarted, so give it a
  # moment; a failure to report is not a failure to upgrade.
  sleep 20
  DETAIL="$(tail -c 1500 "$LOGFILE" | tr -d '\000-\037"\\' )"
  api POST "/api/updates/helper/status/$REQUEST_ID" \
    "{\"status\":\"succeeded\",\"detail\":\"Now running $NEW. $DETAIL\"}" >/dev/null || \
    log "WARN upgraded, but could not report success to the API"
else
  RC=$?
  log "FAIL update-shellius.sh exited $RC — see $LOGFILE"
  DETAIL="$(tail -c 1500 "$LOGFILE" | tr -d '\000-\037"\\' )"
  api POST "/api/updates/helper/status/$REQUEST_ID" \
    "{\"status\":\"failed\",\"detail\":\"update-shellius.sh exited $RC. $DETAIL\"}" >/dev/null || true
  # update-shellius.sh leaves the previous version running when it fails
  # before the swap, and prints its own rollback command when it fails after.
  exit 0
fi

exit 0
