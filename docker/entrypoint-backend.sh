#!/bin/sh
# Backend container entrypoint.
#
# Runs in this order on every container start:
#
#   1. prisma migrate deploy   — apply any pending DB migrations.
#                                 Required, fails the boot on error.
#   2. prisma db seed          — upsert the bootstrap org, super admin,
#                                 baseline groups, and baseline access
#                                 policies. Idempotent: existing groups
#                                 are upserted by name; existing policies
#                                 are NEVER overwritten on re-run, so
#                                 operators can tune them via the UI
#                                 without fear of redeploys stomping
#                                 their edits.
#                                 Soft-fail: a seed error logs a warning
#                                 but does NOT block the server starting.
#                                 (e.g. if SEED_* env vars are temporarily
#                                 missing, the existing data is intact and
#                                 the API should still come up.)
#   3. exec node src/server.js — hand the PID to node so SIGTERM /
#                                 SIGINT propagate cleanly.

set -e

echo "[entrypoint] Applying database migrations..."
npx prisma migrate deploy

echo "[entrypoint] Running idempotent seed (org, super admin, baseline groups + policies)..."
if ! node prisma/seed.js; then
  echo "[entrypoint] WARNING: seed failed — continuing anyway. Check that SEED_ORG_NAME / SEED_ORG_SLUG / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are set in .env.prod for first-time deployments." >&2
fi

echo "[entrypoint] Starting Shellius API server..."
exec node src/server.js
