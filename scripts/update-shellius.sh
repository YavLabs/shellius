#!/usr/bin/env bash
# =============================================================================
# update-shellius.sh — upgrade (or roll back) the Shellius deployment on this
# host (docker-compose.deploy.yml, external PostgreSQL behind PgBouncer).
#
#   ./update-shellius.sh v1.5.2            upgrade to a release tag
#   ./update-shellius.sh 1.5.2 --yes       same, without the confirmation prompt
#   ./update-shellius.sh --rollback        put back the code + images from the
#                                          newest backup (database untouched)
#   ./update-shellius.sh --rollback <name> …from ~/shellius-previous/<name>
#   ./update-shellius.sh --list            list backups
#
# Upgrade steps — the running app is untouched until step 6:
#   1. checks (tools, .env.prod, the tag exists)
#   2. clone the tag into a staging folder, copy .env.prod
#   3. keep the current images as <image>:rollback-<version>, build the new ones
#   4. back up: database → <name>.sql.gz, current folder → <name>-code.zip,
#      both in ~/shellius-previous/<name>/ (name = shellius-<version>-<date>)
#   5. prisma migrate status + deploy, over the direct database IP (not PgBouncer)
#   6. swap the folders and restart the containers, then wait for /api/health
#      to report the new version
#
# Settings (environment variables, defaults in brackets):
#   APP_DIR [~/shellius]  PREV_ROOT [~/shellius-previous]  REPO_URL [GitHub]
#   PG_HOST [ith-pg.ithena.app]  PG_DIRECT_IP [10.1.20.22]
#   DIRECT_DATABASE_URL  full direct URL, instead of rewriting DATABASE_URL
#   HEALTH_URL [http://localhost:8100/api/health]  KEEP_BACKUPS [0 = keep all]
#
# Secrets: database URLs are never printed and are passed to containers via
# the environment, not on the command line. Backups are private (folders
# 700, files 600 — the code zip contains .env.prod); the code itself keeps
# normal permissions because the images copy them.
# =============================================================================
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/YavLabs/shellius.git}"
APP_DIR="${APP_DIR:-$HOME/shellius}"
PREV_ROOT="${PREV_ROOT:-$HOME/shellius-previous}"
PROJECT="${COMPOSE_PROJECT:-shellius}"   # keeps the redis_data volume + container names
COMPOSE_FILE="docker-compose.deploy.yml"
ENV_FILE=".env.prod"
PG_HOST="${PG_HOST:-ith-pg.ithena.app}"
PG_DIRECT_IP="${PG_DIRECT_IP:-10.1.20.22}"
PG_IMAGE="${PG_IMAGE:-postgres:18-alpine}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8100/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
KEEP_BACKUPS="${KEEP_BACKUPS:-0}"
BUILT_IMAGES=(shellius-backend:local shellius-frontend:local shellius-guacd:h264)

# --- output ------------------------------------------------------------------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓ %s%s\n' "$G" "$*" "$N"; }
warn() { printf '    %s! %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

usage() { sed -n '6,11p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply=
  read -r -p "    $1 [y/N] " reply || die "No answer (not a terminal?) — rerun with --yes."
  [[ "$reply" =~ ^[Yy]$ ]] || die "Cancelled."
}

# --- arguments ---------------------------------------------------------------
MODE=upgrade; TAG=; ROLLBACK_NAME=; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --rollback) MODE=rollback; if [ $# -gt 1 ] && [[ "$2" != -* ]]; then ROLLBACK_NAME="$2"; shift; fi ;;
    --list) MODE=list ;;
    -h|--help) usage 0 ;;
    -*) die "Unknown option: $1 (see --help)" ;;
    *) [ -z "$TAG" ] || die "Only one version, please."; TAG="$1" ;;
  esac
  shift
done

# Normal permissions for the code we clone and build (the images copy them:
# a private checkout makes /app unreadable to the container's user). Only
# the backups are private — see private_dir.
umask 022
private_dir() { mkdir -p "$1" && chmod 700 "$1"; }
private_dir "$PREV_ROOT"

# One run at a time.
exec 9>"$PREV_ROOT/.update.lock"
flock -n 9 || die "Another update-shellius.sh is running."

current_version() { [ -f "$APP_DIR/VERSION" ] && tr -d '[:space:]' <"$APP_DIR/VERSION" || echo unknown; }

# DATABASE_URL from .env.prod, rewritten to the direct IP (migrations and
# pg_dump don't work through PgBouncer). Sets DUMP_URL and DIRECT_URL.
database_urls() {
  local env="$1" raw
  if [ -n "${DIRECT_DATABASE_URL:-}" ]; then
    DIRECT_URL="$DIRECT_DATABASE_URL"
  else
    raw=$(grep -E '^DATABASE_URL=' "$env" | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//')
    [ -n "$raw" ] || die "DATABASE_URL not found in $env."
    [[ "$raw" == *"@$PG_HOST:"* ]] || die "DATABASE_URL doesn't point at $PG_HOST — set DIRECT_DATABASE_URL (or PG_HOST) and rerun."
    DIRECT_URL=$(printf '%s' "$raw" | sed -E "s/@${PG_HOST//./\\.}:/@${PG_DIRECT_IP}:/; s/[&?]pgbouncer=true//; s/[&?]connection_limit=[0-9]+//")
  fi
  DUMP_URL="${DIRECT_URL%%\?*}"
}

wait_healthy() {
  local want="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) body
  while [ $SECONDS -lt $deadline ]; do
    body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
    if [ -n "$body" ]; then
      local got; got=$(printf '%s' "$body" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ -z "$want" ] || [ "$got" = "$want" ]; then ok "Healthy — version ${got:-?}"; return 0; fi
    fi
    sleep 5
  done
  warn "No healthy response with version ${want:-?} from $HEALTH_URL after ${HEALTH_TIMEOUT}s."
  (cd "$APP_DIR" && compose logs --tail 40 backend) || true
  return 1
}

prune_backups() {
  [ "$KEEP_BACKUPS" -gt 0 ] 2>/dev/null || return 0
  local old
  mapfile -t old < <(ls -1dt "$PREV_ROOT"/shellius-*/ 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))")
  for d in "${old[@]}"; do rm -rf -- "$d"; info "Removed old backup $(basename "$d")"; done
}

# --- list ----------------------------------------------------------------------
if [ "$MODE" = list ]; then
  ls -1dt "$PREV_ROOT"/shellius-*/ 2>/dev/null | while read -r d; do
    printf '%s  %s\n' "$(basename "$d")" "$(du -sh "$d" | cut -f1)"
  done
  exit 0
fi

for cmd in git docker zip unzip gzip curl flock; do
  command -v "$cmd" >/dev/null || die "'$cmd' is not installed (Debian/Ubuntu: sudo apt-get install -y zip unzip)."
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ('docker compose') is required."

# --- rollback ------------------------------------------------------------------
if [ "$MODE" = rollback ]; then
  if [ -z "$ROLLBACK_NAME" ]; then
    ROLLBACK_NAME=$(ls -1dt "$PREV_ROOT"/shellius-*/ 2>/dev/null | head -1 | xargs -r basename)
  fi
  BK="$PREV_ROOT/$ROLLBACK_NAME"
  ZIP="$BK/$ROLLBACK_NAME-code.zip"
  [ -n "$ROLLBACK_NAME" ] && [ -f "$ZIP" ] || die "No backup to roll back to (looked for $ZIP)."
  OLD_VER=$(echo "$ROLLBACK_NAME" | sed -E 's/^shellius-(.*)-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$/\1/')

  step "Roll back to $ROLLBACK_NAME (code + images; the database is not changed)"
  info "Running now: $(current_version)"
  confirm "Continue?"

  STAGE=$(mktemp -d "$HOME/.shellius-rollback.XXXXXX")
  trap 'rm -rf "$STAGE"' EXIT
  unzip -q "$ZIP" -d "$STAGE"
  RESTORED="$STAGE/$(basename "$APP_DIR")"
  [ -f "$RESTORED/$COMPOSE_FILE" ] || die "The backup zip doesn't contain $(basename "$APP_DIR")/$COMPOSE_FILE."

  step "Images"
  missing=0
  for img in "${BUILT_IMAGES[@]}"; do
    if docker image inspect "${img%%:*}:rollback-$OLD_VER" >/dev/null 2>&1; then
      docker tag "${img%%:*}:rollback-$OLD_VER" "$img"; ok "$img ← rollback-$OLD_VER"
    else
      missing=1
    fi
  done
  if [ "$missing" = 1 ]; then
    info "Some rollback images are gone — rebuilding from the backup."
    (cd "$RESTORED" && APP_VERSION="$OLD_VER" GIT_SHA="v$OLD_VER" compose build)
  fi

  step "Swap folders and restart"
  rm -rf -- "$APP_DIR"
  mv "$RESTORED" "$APP_DIR"
  (cd "$APP_DIR" && APP_VERSION="$OLD_VER" GIT_SHA="v$OLD_VER" compose up -d --force-recreate)
  wait_healthy "$OLD_VER" || die "Rolled back, but the health check didn't pass — check the logs above."

  printf '\n%sRolled back to %s.%s\n' "$G" "$OLD_VER" "$N"
  info "Database unchanged. Shellius migrations only add tables/columns, so the older version runs on it."
  info "The database as it was before that upgrade is in $BK/$ROLLBACK_NAME.sql.gz"
  info "(restore it only into an emptied database, over the direct IP)."
  exit 0
fi

# --- upgrade -------------------------------------------------------------------
[ -n "$TAG" ] || usage 1
[[ "$TAG" == v* ]] || TAG="v$TAG"
NEW_VER="${TAG#v}"
[ -d "$APP_DIR" ] || die "$APP_DIR not found (set APP_DIR)."
[ -f "$APP_DIR/$ENV_FILE" ] || die "$APP_DIR/$ENV_FILE not found."

CUR_VER=$(current_version)
STAMP=$(date +%F-%H%M)
BK_NAME="shellius-$CUR_VER-$STAMP"
BK_DIR="$PREV_ROOT/$BK_NAME"

step "1/6 Checks"
git ls-remote --exit-code --tags "$REPO_URL" "refs/tags/$TAG" >/dev/null 2>&1 || die "Tag $TAG not found on $REPO_URL."
info "Running now:   $CUR_VER ($APP_DIR)"
info "Upgrading to:  $NEW_VER"
info "Backups go to: $BK_DIR/"
[ "$CUR_VER" = "$NEW_VER" ] && warn "$NEW_VER is already installed — this reinstalls it."
database_urls "$APP_DIR/$ENV_FILE"
ok "Database: direct connection via $PG_DIRECT_IP"
confirm "Continue?"

SWAPPED=0
RETAGGED=0
STAGE_ROOT=$(mktemp -d "$HOME/.shellius-stage.XXXXXX")
STAGE="$STAGE_ROOT/$(basename "$APP_DIR")"
on_exit() {
  local rc=$?
  rm -rf "$STAGE_ROOT"
  if [ $rc -ne 0 ] && [ "$SWAPPED" = 0 ]; then
    # Put the previous images back under their normal tags, so a later
    # restart doesn't pick up an unfinished build.
    if [ "$RETAGGED" = 1 ]; then
      for img in "${BUILT_IMAGES[@]}"; do
        docker image inspect "${img%%:*}:rollback-$CUR_VER" >/dev/null 2>&1 \
          && docker tag "${img%%:*}:rollback-$CUR_VER" "$img" || true
      done
      printf '%sRestored the %s images.%s\n' "$Y" "$CUR_VER" "$N" >&2
    fi
    printf '\n%sStopped before the switch — the running version (%s) was not changed.%s\n' "$Y" "$CUR_VER" "$N" >&2
  fi
}
trap on_exit EXIT

step "2/6 Fetch $TAG"
git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" "$REPO_URL" "$STAGE"
cp -p "$APP_DIR/$ENV_FILE" "$STAGE/$ENV_FILE"
ok "Code in staging; $ENV_FILE copied"

step "3/6 Build images (the running containers keep going)"
for img in "${BUILT_IMAGES[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    docker tag "$img" "${img%%:*}:rollback-$CUR_VER"
    info "Kept $img as ${img%%:*}:rollback-$CUR_VER"
    RETAGGED=1
  fi
done
(cd "$STAGE" && APP_VERSION="$NEW_VER" GIT_SHA="$TAG" compose build)
# The images run as non-root users: make sure they can read their own files.
docker run --rm --entrypoint sh shellius-backend:local -c 'test -r /app/package.json && test -r /app/src/server.js' \
  || die "The new backend image can't read its own files (permissions) — not deploying it."
docker run --rm --entrypoint sh shellius-frontend:local -c 'test -r /usr/share/nginx/html/index.html' \
  || die "The new frontend image can't read its own files (permissions) — not deploying it."
ok "Built $NEW_VER (images checked)"

step "4/6 Back up to $BK_DIR"
private_dir "$BK_DIR"
DUMP_URL="$DUMP_URL" docker run --rm -e DUMP_URL "$PG_IMAGE" sh -c 'pg_dump "$DUMP_URL"' | gzip >"$BK_DIR/$BK_NAME.sql.gz"
gzip -t "$BK_DIR/$BK_NAME.sql.gz" || die "The database dump is corrupt."
[ "$(gzip -cd "$BK_DIR/$BK_NAME.sql.gz" | head -c 4096 | wc -c)" -ge 1024 ] || die "The database dump is empty."
chmod 600 "$BK_DIR/$BK_NAME.sql.gz"
ok "Database → $BK_NAME.sql.gz ($(du -h "$BK_DIR/$BK_NAME.sql.gz" | cut -f1))"
(cd "$(dirname "$APP_DIR")" && zip -qry "$BK_DIR/$BK_NAME-code.zip" "$(basename "$APP_DIR")")
chmod 600 "$BK_DIR/$BK_NAME-code.zip"
ok "Code → $BK_NAME-code.zip ($(du -h "$BK_DIR/$BK_NAME-code.zip" | cut -f1), includes $ENV_FILE)"

step "5/6 Database migrations"
export DATABASE_URL="$DIRECT_URL"
(cd "$STAGE" && compose run --rm --no-deps -e DATABASE_URL --entrypoint sh backend -c "npx prisma migrate status") || true
(cd "$STAGE" && compose run --rm --no-deps -e DATABASE_URL --entrypoint sh backend -c "npx prisma migrate deploy") \
  || die "Migration failed — nothing was restarted. Backup: $BK_DIR/"
unset DATABASE_URL
ok "Migrations applied"

step "6/6 Switch to $NEW_VER and restart"
rm -rf -- "$APP_DIR"
mv "$STAGE" "$APP_DIR"
SWAPPED=1
(cd "$APP_DIR" && APP_VERSION="$NEW_VER" GIT_SHA="$TAG" compose up -d --force-recreate)
if ! wait_healthy "$NEW_VER"; then
  printf '\n%sThe new version did not come up healthy.%s Roll back with:\n    %s --rollback %s\n' "$R" "$N" "$0" "$BK_NAME" >&2
  exit 1
fi

prune_backups
printf '\n%sShellius %s is running.%s\n' "$G" "$NEW_VER" "$N"
info "Backup of $CUR_VER: $BK_DIR/"
info "Undo (code + images): $0 --rollback $BK_NAME"
