#!/usr/bin/env bash
#
# verify-migrations.sh
#
# Verifies that the Prisma migration chain in backend/prisma/migrations is
# safe to run with `prisma migrate deploy` in both of the situations that
# matter in production:
#
#   1. FRESH     — a brand-new, empty database (new installs).
#   2. EXISTING  — a database that already has every migration that existed
#                  on `main` applied (a real deployment that has been
#                  running for a while and is now upgrading).
#   3. EXISTING-dev — a database that already has ALL migrations currently
#                  on this branch applied (simulates re-running `migrate
#                  deploy` against a dev DB that got its schema via
#                  workarounds, e.g. `db push`, but has since had every
#                  migration name marked as applied).
#
# In every case, after `prisma migrate deploy` finishes, the resulting
# database must match backend/prisma/schema.prisma exactly (empty
# `prisma migrate diff`).
#
# Requires: docker, a free TCP port, npx/prisma available in backend/.
#
# Usage:
#   backend/scripts/verify-migrations.sh
#   npm --prefix backend run db:verify-migrations
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/prisma/migrations"
SCHEMA="$BACKEND_DIR/prisma/schema.prisma"

CONTAINER_NAME="shellius-verify-migrations-$$"
PGPORT="${PGPORT:-}"
WORKDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
pass() { printf '\033[1;32m  PASS:\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m  FAIL:\033[0m %s\n' "$1"; exit 1; }

# --- Find a free port ------------------------------------------------------
if [ -z "$PGPORT" ]; then
  PGPORT=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});')
fi

log "Starting throwaway Postgres 16 container on 127.0.0.1:$PGPORT ..."
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=verify \
  -e POSTGRES_DB=verify \
  -p "127.0.0.1:${PGPORT}:5432" \
  postgres:16 >/dev/null

log "Waiting for Postgres to accept connections..."
# Postgres restarts once during first-time initdb (starts, stops to apply
# config, starts again), so pg_isready can report success before the final
# restart. Require several consecutive successful, *actual* queries before
# trusting it's stable.
ready_streak=0
for i in $(seq 1 90); do
  if docker exec "$CONTAINER_NAME" psql -U postgres -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    ready_streak=$((ready_streak + 1))
    if [ "$ready_streak" -ge 3 ]; then
      break
    fi
  else
    ready_streak=0
  fi
  sleep 1
  if [ "$i" -eq 90 ]; then
    fail "Postgres did not become ready in time"
  fi
done

BASE_URL="postgresql://postgres:verify@127.0.0.1:${PGPORT}/verify"

reset_db() {
  docker exec "$CONTAINER_NAME" psql -U postgres -d verify \
    -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
}

apply_sql_file() {
  docker exec -i "$CONTAINER_NAME" psql -U postgres -d verify -v ON_ERROR_STOP=1 -f /dev/stdin < "$1"
}

diff_is_empty() {
  local out
  out=$(cd "$BACKEND_DIR" && DATABASE_URL="$BASE_URL" npx prisma migrate diff \
    --from-url "$BASE_URL" \
    --to-schema-datamodel "$SCHEMA" \
    --script 2>/dev/null)
  [ "$(printf '%s' "$out" | grep -v '^--' | tr -d '[:space:]')" = "" ]
}

# ============================================================================
# Scenario 1: FRESH — empty database
# ============================================================================
log "Scenario 1/3: FRESH — empty database -> migrate deploy -> diff"
reset_db
(cd "$BACKEND_DIR" && DATABASE_URL="$BASE_URL" npx prisma migrate deploy) \
  || fail "migrate deploy failed on a fresh database"
pass "migrate deploy succeeded on fresh database"

if diff_is_empty; then
  pass "schema matches prisma/schema.prisma exactly (empty diff)"
else
  fail "schema differs from prisma/schema.prisma after migrate deploy on fresh DB"
fi

# ============================================================================
# Scenario 2: EXISTING — DB built from main's schema, main's migrations
#             marked applied, then this branch's migrate deploy runs.
# ============================================================================
log "Scenario 2/3: EXISTING (simulated main deployment) -> migrate deploy -> diff"
reset_db

MAIN_SCHEMA="$WORKDIR/main_schema.prisma"
if ! git -C "$REPO_DIR" show main:backend/prisma/schema.prisma > "$MAIN_SCHEMA" 2>/dev/null; then
  echo "  (skipping: no 'main' ref available in this checkout)"
else
  BUILD_SQL="$WORKDIR/main_build.sql"
  (cd "$BACKEND_DIR" && npx prisma migrate diff \
    --from-empty --to-schema-datamodel "$MAIN_SCHEMA" --script 2>/dev/null) > "$BUILD_SQL"
  apply_sql_file "$BUILD_SQL" >/dev/null \
    || fail "could not build a database from main's schema"

  mapfile -t MAIN_MIGRATIONS < <(git -C "$REPO_DIR" ls-tree -r main --name-only -- backend/prisma/migrations \
    | grep migration.sql | sed 's#backend/prisma/migrations/##;s#/migration.sql##' | sort)

  for name in "${MAIN_MIGRATIONS[@]}"; do
    (cd "$BACKEND_DIR" && DATABASE_URL="$BASE_URL" npx prisma migrate resolve --applied "$name" >/dev/null 2>&1) \
      || fail "could not mark $name as applied"
  done
  pass "marked ${#MAIN_MIGRATIONS[@]} main migrations as applied"

  (cd "$BACKEND_DIR" && DATABASE_URL="$BASE_URL" npx prisma migrate deploy) \
    || fail "migrate deploy failed on simulated main deployment"
  pass "migrate deploy succeeded on simulated main deployment (gap-fills applied as no-ops)"

  if diff_is_empty; then
    pass "schema matches prisma/schema.prisma exactly (empty diff)"
  else
    fail "schema differs from prisma/schema.prisma after migrate deploy on existing (main) DB"
  fi
fi

# ============================================================================
# Scenario 3: EXISTING-dev — DB built from current full schema, ALL current
#             migrations marked applied, then migrate deploy runs.
# ============================================================================
log "Scenario 3/3: EXISTING-dev (current full schema, all migrations marked) -> migrate deploy -> diff"
reset_db

FULL_BUILD_SQL="$WORKDIR/full_build.sql"
(cd "$BACKEND_DIR" && npx prisma migrate diff \
  --from-empty --to-schema-datamodel "$SCHEMA" --script 2>/dev/null) > "$FULL_BUILD_SQL"
apply_sql_file "$FULL_BUILD_SQL" >/dev/null \
  || fail "could not build a database from the current schema"

mapfile -t ALL_MIGRATIONS < <(ls -d "$MIGRATIONS_DIR"/*/ | xargs -n1 basename | sort)
for name in "${ALL_MIGRATIONS[@]}"; do
  (cd "$BACKEND_DIR" && DATABASE_URL="$BASE_URL" npx prisma migrate resolve --applied "$name" >/dev/null 2>&1) \
    || fail "could not mark $name as applied"
done
pass "marked all ${#ALL_MIGRATIONS[@]} current migrations as applied"

(cd "$BACKEND_DIR" && DATABASE_URL="$BASE_URL" npx prisma migrate deploy) \
  || fail "migrate deploy failed on existing-dev DB"
pass "migrate deploy succeeded on existing-dev DB"

if diff_is_empty; then
  pass "schema matches prisma/schema.prisma exactly (empty diff)"
else
  fail "schema differs from prisma/schema.prisma after migrate deploy on existing-dev DB"
fi

log "All migration verification scenarios passed."
