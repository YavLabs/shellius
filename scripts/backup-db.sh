#!/usr/bin/env bash
# backup-db.sh — pg_dump the Shellius postgres container to a compressed archive.
# Usage: ./scripts/backup-db.sh [compose-project-name]
# Requires: docker, gzip
# Retention: keeps last 14 daily backups in ./backups/

set -euo pipefail

COMPOSE_PROJECT="${1:-shellius}"
CONTAINER="${COMPOSE_PROJECT}-postgres-1"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP="$(date +%F_%H-%M-%S)"
BACKUP_FILE="${BACKUP_DIR}/db-${TIMESTAMP}.sql.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

echo "[backup-db] Starting database backup → ${BACKUP_FILE}"

# Dump via pg_dump inside the running postgres container
docker exec "${CONTAINER}" pg_dump \
  -U "${POSTGRES_USER:-shellius}" \
  --no-password \
  "${POSTGRES_DB:-shellius}" \
  | gzip -9 > "${BACKUP_FILE}"

BACKUP_SIZE="$(du -sh "${BACKUP_FILE}" | cut -f1)"
echo "[backup-db] Backup complete: ${BACKUP_FILE} (${BACKUP_SIZE})"

# Retention — remove backups older than RETENTION_DAYS days
echo "[backup-db] Pruning backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -maxdepth 1 -name "db-*.sql.gz" -mtime "+${RETENTION_DAYS}" -print -delete

echo "[backup-db] Done."
