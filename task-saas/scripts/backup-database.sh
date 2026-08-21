#!/usr/bin/env bash
#
# Non-destructive PostgreSQL backup for CodeMind.
#
# Produces a compressed custom-format dump suitable for pg_restore. It ONLY reads:
# there is no DROP, no TRUNCATE, and no `prisma migrate reset` anywhere in this
# script or in the documented restore path. Run it before any migration.
#
# Usage:
#   ./scripts/backup-database.sh                      # uses DATABASE_URL from .env
#   DATABASE_URL="postgres://..." ./scripts/backup-database.sh
#   ./scripts/backup-database.sh --docker task-saas-db-1   # dump from a container
#
# Restore into a NEW, EMPTY database (never over a populated one):
#   pg_restore --no-owner --no-privileges -d "$TARGET_URL" backups/<file>.dump

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CONTAINER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --docker) CONTAINER="${2:-}"; shift 2 ;;
    --out)    BACKUP_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Load DATABASE_URL from .env only if it is not already set, so an explicitly
# exported value always wins.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi

mkdir -p "$BACKUP_DIR"
OUTFILE="$BACKUP_DIR/codemind-$STAMP.dump"

if [ -n "$CONTAINER" ]; then
  # Dump from inside a container (the local docker-compose Postgres).
  DB_USER="${POSTGRES_USER:-postgres}"
  DB_NAME="${POSTGRES_DB:-tasksaas}"
  echo "Dumping database '$DB_NAME' from container '$CONTAINER'..."
  docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$OUTFILE"
else
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is not set and no .env entry was found." >&2
    exit 1
  fi
  # The URL is passed as a single argument and never echoed, so the password
  # cannot leak into the terminal or CI logs.
  echo "Dumping database via DATABASE_URL..."
  pg_dump "$DATABASE_URL" -Fc > "$OUTFILE"
fi

SIZE="$(wc -c < "$OUTFILE" | tr -d ' ')"

# A dump smaller than a valid header means pg_dump failed silently; refuse to let
# that be mistaken for a good backup.
if [ "$SIZE" -lt 1024 ]; then
  echo "Backup looks empty (${SIZE} bytes). Not treating this as a valid backup." >&2
  exit 1
fi

echo "Backup written: $OUTFILE (${SIZE} bytes)"
echo
echo "Verify before migrating:"
echo "  pg_restore --list \"$OUTFILE\" | head"
