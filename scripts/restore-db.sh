#!/usr/bin/env bash
# Restore a backup made by scripts/backup-db.sh into a NEW database. It never overwrites a database:
# restore to a side database, check it, then swap during a maintenance window (docs/operations.md
# "Restoring").
#   scripts/restore-db.sh backups/derivdesk-20261019T060000Z.dump derivdesk_restored
#
# Needs the two application role passwords so the roles exist with real credentials before the
# restore (the dump carries grants, not roles):
#   DERIVDESK_API_DB_PASSWORD, DERIVDESK_ADMIN_DB_PASSWORD
# Settings: COMPOSE_FILE (default docker-compose.prod.yml), or DIRECT_PG=1 PGURL=<superuser url to the
# `postgres` maintenance database>.
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:?usage: restore-db.sh <backup file> <new database name>}"
target="${2:?usage: restore-db.sh <backup file> <new database name>}"
[[ -f "$file" ]] || { echo "No such file: $file" >&2; exit 1; }
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "Database name must be lower-case letters, digits, underscore" >&2; exit 1; }
: "${DERIVDESK_API_DB_PASSWORD:?required}"
: "${DERIVDESK_ADMIN_DB_PASSWORD:?required}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

if [[ "${DIRECT_PG:-0}" == "1" ]]; then
  : "${PGURL:?PGURL is required with DIRECT_PG=1}"
  psql_su()    { psql "$PGURL" -v ON_ERROR_STOP=1 -q "$@"; }
  restore_to() { local u; u="$(python3 - "$PGURL" "$1" <<'PY'
import sys, urllib.parse as p
u = p.urlsplit(sys.argv[1]); print(p.urlunsplit(u._replace(path="/" + sys.argv[2])))
PY
)"; pg_restore --no-owner --exit-on-error --dbname "$u"; }
else
  psql_su()    { docker compose -f "$COMPOSE_FILE" exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }
  restore_to() { docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --no-owner --exit-on-error -U postgres -d "$1"; }
fi

exists="$(psql_su -At -c "SELECT 1 FROM pg_database WHERE datname = '$target'")"
[[ -z "$exists" ]] || { echo "Database '$target' already exists — refusing to touch it. Pick a new name." >&2; exit 1; }

# Roles first (real passwords, never the placeholders).
for spec in "derivdesk_api:$DERIVDESK_API_DB_PASSWORD" "derivdesk_admin:$DERIVDESK_ADMIN_DB_PASSWORD"; do
  role="${spec%%:*}"; pw="${spec#*:}"
  printf 'SELECT format(%s, :'"'"'role'"'"', :'"'"'pw'"'"') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'"'"'role'"'"') \\gexec\n' "'CREATE ROLE %I LOGIN PASSWORD %L'" | psql_su -v role="$role" -v pw="$pw"
done

psql_su -c "CREATE DATABASE $target"
if [[ "$file" == *.gpg ]]; then gpg --batch --decrypt "$file" | restore_to "$target"; else restore_to "$target" < "$file"; fi

echo "Restored into '$target'. Next: verify row counts, then swap (docs/operations.md)."
