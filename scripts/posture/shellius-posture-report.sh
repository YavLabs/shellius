#!/usr/bin/env bash
#
# shellius-posture-report — runs the collector and POSTs the snapshot to
# the Shellius API. Invoked by shellius-posture.timer every 5 minutes
# (org-configurable; see docs/posture/posture-spec.md §4).
#
# Auth: identical mechanism to /usr/local/sbin/shellius-heartbeat — the
# per-host agent token at /etc/shellius/agent-token, sent as the
# 'x-agent-token' header (see backend/src/middleware/agentAuth.js and the
# heartbeat script embedded in routes/bootstrap.js step 8). serverId/orgId
# are NOT sent in the body: agentAuth resolves identity from the token
# itself, same rule POST /api/hosts/heartbeat follows.
#
# This script is deliberately inert on failure: a collector crash, a
# network error, or a rejected payload must never touch sshd, never retry
# forever, and never exit non-zero in a way that could be mistaken by
# other tooling for an SSH-auth-path failure. It only ever reports.
#
# Usage: shellius-posture-report [--api-url URL] [--token-file PATH]
#   (both default to the values baked in by bootstrap.js; the flags exist
#   for local testing against a non-default API endpoint.)

set -uo pipefail

API_URL="__SHELLIUS_POSTURE_API_URL__"
TOKEN_FILE="/etc/shellius/agent-token"
COLLECTOR="/usr/local/sbin/shellius-posture-collect"
LOG_TAG="shellius-posture"

# Hard cap mirrors the server's own limit (docs/posture/posture-spec.md §3:
# whole body <= 256 KB, reject never truncate). Enforcing it here too means
# a runaway host never wastes a round trip on a payload the server would
# reject anyway, and we never silently truncate a JSON body — a truncated
# JSON body is worse than no body, since it could parse as something
# different from what was collected.
MAX_BYTES=262144
CURL_TIMEOUT=15
MAX_ATTEMPTS=2
RETRY_DELAY_SECONDS=3

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() { logger -t "$LOG_TAG" "$1" 2>/dev/null || true; }

# Tell the API about a failure that happened HERE, before any snapshot could
# be sent — collector missing, crashed with no output, snapshot too large.
# Those used to reach the journal and nowhere else, so the UI could only say
# "stopped reporting" and nobody knew to look on the host. One attempt,
# short timeout, a one-line reason; never retried, never fatal.
report_problem() {
  [ -n "${TOKEN:-}" ] || return 0
  local reason
  reason=$(printf '%s' "$1" | tr -d '\000-\037"\\' | cut -c1-900)
  curl -fsS --max-time 10 \
    -H "x-agent-token: $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST \
    --data-binary "{\"reason\":\"$reason\"}" \
    -o /dev/null \
    "$API_URL/api/hosts/posture/problem" >/dev/null 2>&1 || true
}

WORKDIR="$(mktemp -d)" || { log "FAIL cannot create temp dir"; exit 0; }
trap 'rm -rf "$WORKDIR"' EXIT

# The token first: without it nothing can be reported to the API, including
# the failures below.
if [ ! -r "$TOKEN_FILE" ]; then
  log "FAIL agent token unreadable: $TOKEN_FILE"
  exit 0
fi
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  log "FAIL agent token file empty: $TOKEN_FILE"
  exit 0
fi

if [ ! -x "$COLLECTOR" ]; then
  log "FAIL collector not found or not executable: $COLLECTOR"
  report_problem "the collector is missing or not executable at $COLLECTOR"
  exit 0
fi

PAYLOAD="$("$COLLECTOR" 2>"$WORKDIR/collect.err")"
COLLECTOR_EXIT=$?
if [ -z "$PAYLOAD" ]; then
  ERR_TAIL="$(tail -c 300 "$WORKDIR/collect.err" 2>/dev/null)"
  log "FAIL collector produced no output (exit=$COLLECTOR_EXIT): $ERR_TAIL"
  report_problem "the collector exited $COLLECTOR_EXIT with no output: $ERR_TAIL"
  exit 0
fi

PAYLOAD_BYTES=${#PAYLOAD}
if [ "$PAYLOAD_BYTES" -gt "$MAX_BYTES" ]; then
  # Never truncate and send a mangled body — drop the round trip entirely
  # and report why. The next scheduled run tries again; a host that is
  # persistently over the cap needs a real fix (see degradedReason), not a
  # script that silently ships broken JSON.
  log "FAIL payload too large ($PAYLOAD_BYTES bytes > $MAX_BYTES) — dropping this cycle, not truncating"
  report_problem "the snapshot is $PAYLOAD_BYTES bytes, over the $MAX_BYTES limit, so it was not sent"
  exit 0
fi

# curl -f makes the exit code do the classifying for us:
#   0  -> 2xx, accepted
#   22 -> HTTP error (4xx/5xx); http_code in $WORKDIR/http_code tells us which
#   anything else -> transport/network failure (DNS, connect, TLS, timeout)
post_once() {
  curl -fsS \
    --max-time "$CURL_TIMEOUT" \
    -H "x-agent-token: $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST \
    --data-binary "$PAYLOAD" \
    -o /dev/null \
    -w '%{http_code}' \
    "$API_URL/api/hosts/posture" \
    >"$WORKDIR/http_code" 2>"$WORKDIR/curl.err"
}

ATTEMPT=1
while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  post_once
  RC=$?
  HTTP_CODE="$(cat "$WORKDIR/http_code" 2>/dev/null || echo '')"

  if [ "$RC" -eq 0 ]; then
    log "OK posture snapshot accepted (${PAYLOAD_BYTES} bytes, http=${HTTP_CODE:-200})"
    exit 0
  fi

  # Retry only on TRANSIENT failure: a transport error (RC not 22, e.g.
  # couldn't connect or timed out) or a 5xx from the server. A 4xx (bad
  # token, oversized/invalid payload per the server's own caps) is not
  # transient — retrying it just spams the API with the same rejected
  # body, so stop immediately.
  if [ "$RC" -ne 22 ]; then
    log "WARN attempt $ATTEMPT: transport error rc=$RC: $(tail -c 300 "$WORKDIR/curl.err" 2>/dev/null)"
  elif printf '%s' "$HTTP_CODE" | grep -qE '^5[0-9][0-9]$'; then
    log "WARN attempt $ATTEMPT: server error http=$HTTP_CODE"
  else
    log "FAIL rejected http=${HTTP_CODE:-unknown} (not retrying — not a transient failure)"
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ] && sleep "$RETRY_DELAY_SECONDS"
done

log "FAIL posture snapshot not accepted after $MAX_ATTEMPTS attempts"
exit 0
