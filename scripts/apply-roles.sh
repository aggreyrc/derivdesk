#!/usr/bin/env bash
# Applies infra/db-init/001_roles.sql AFTER migrations. Safe to re-run — run it again
# after any migration that adds tables, so new tables get (or are denied) the right grants.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d derivdesk < infra/db-init/001_roles.sql

# Replace the placeholder passwords baked into the SQL. Set these in the environment of whoever runs
# this script. Production config (apps/api, apps/admin-api) REFUSES to boot while a DATABASE_URL
# still contains "change_me". psql substitutes :'pw' as a properly quoted literal, so the value is
# never spliced into a shell or SQL string by hand.
set_role_password() { # $1 = role, $2 = password
  printf 'ALTER ROLE %s PASSWORD :'"'"'pw'"'"';\n' "$1" |
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d derivdesk -v pw="$2"
}
[[ -n "${DERIVDESK_API_DB_PASSWORD:-}" ]] && set_role_password derivdesk_api "$DERIVDESK_API_DB_PASSWORD"
[[ -n "${DERIVDESK_ADMIN_DB_PASSWORD:-}" ]] && set_role_password derivdesk_admin "$DERIVDESK_ADMIN_DB_PASSWORD"
echo "Roles and grants applied."
