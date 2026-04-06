#!/usr/bin/env bash
# backup-recordings.sh — archive the Shellius recordings volume to a tar.gz.
# Usage: ./scripts/backup-recordings.sh [recordings-path]
# Default recordings path: /data/recordings (from the backend container mount).
# Requires: docker, tar, gzip
# Retention: keeps last 14 daily archives in ./backups/

set -euo pipefail

COMPOSE_PROJECT="${SHELLIUS_COMPOSE_PROJECT:-shellius}"
CONTAINER="${COMPOSE_PROJECT}-backend-1"
# Source path inside the container; matches RECORDINGS_DIR env var default
RECORDINGS_PATH="${1:-/data/recordings}"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP="$(date +%F_%H-%M-%S)"
BACKUP_FILE="${BACKUP_DIR}/recordings-${TIMESTAMP}.tar.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

echo "[backup-recordings] Archiving ${RECORDINGS_PATH} from container ${CONTAINER} → ${BACKUP_FILE}"

# Stream a tar archive from inside the container and compress locally
docker exec "${CONTAINER}" tar -C "$(dirname "${RECORDINGS_PATH}")" -cf - "$(basename "${RECORDINGS_PATH}")" \
  | gzip -9 > "${BACKUP_FILE}"

BACKUP_SIZE="$(du -sh "${BACKUP_FILE}" | cut -f1)"
echo "[backup-recordings] Archive complete: ${BACKUP_FILE} (${BACKUP_SIZE})"

# Retention — remove archives older than RETENTION_DAYS days
echo "[backup-recordings] Pruning archives older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -maxdepth 1 -name "recordings-*.tar.gz" -mtime "+${RETENTION_DAYS}" -print -delete

echo "[backup-recordings] Done."
