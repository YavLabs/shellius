#!/bin/sh
# All-in-one container start (docker/Dockerfile.allinone). Runs under tini.
#
#   1. prisma migrate deploy   required; the container exits if it fails
#   2. prisma/seed.js          idempotent (org, super admin, baseline groups
#                              and policies); soft-fail, same as the backend image
#   3. start the API (node, 127.0.0.1:3001) and nginx (:8080) side by side
#
# If either process exits, the other is stopped and the container exits with
# that status, so Docker / Kubernetes / Coolify restarts the whole unit
# instead of leaving half an app running. SIGTERM/SIGINT are forwarded to
# both, and the API gets time to end live terminal sessions cleanly.

set -eu
cd /app

echo "[shellius] Applying database migrations..."
node node_modules/prisma/build/index.js migrate deploy

echo "[shellius] Running idempotent seed..."
if ! node prisma/seed.js; then
  echo "[shellius] WARNING: seed failed; continuing. For a first install set SEED_ORG_NAME / SEED_ORG_SLUG / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD." >&2
fi

mkdir -p /tmp/nginx

echo "[shellius] Starting API..."
node src/server.js &
API_PID=$!

echo "[shellius] Starting nginx on :8080..."
nginx -g 'daemon off;' &
NGINX_PID=$!

stop() {
  trap - TERM INT
  kill -TERM "$NGINX_PID" "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$NGINX_PID" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT

# Supervise: exit as soon as either process is gone.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 2
done

STATUS=0
if ! kill -0 "$API_PID" 2>/dev/null; then
  wait "$API_PID" || STATUS=$?
  echo "[shellius] API exited (status $STATUS); stopping nginx." >&2
else
  wait "$NGINX_PID" || STATUS=$?
  echo "[shellius] nginx exited (status $STATUS); stopping API." >&2
fi
stop
# Either process stopping on its own is a failure for the container as a whole.
[ "$STATUS" -eq 0 ] && STATUS=1
exit "$STATUS"
