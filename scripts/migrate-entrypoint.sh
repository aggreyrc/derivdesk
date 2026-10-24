#!/usr/bin/env bash
# One-shot deploy step: bring the database to the schema this release expects, then (re)apply the
# least-privilege roles. Runs inside the `migrate` image (infra/docker/migrate.Dockerfile) as part of
# every deploy, BEFORE the API containers start. Safe to re-run: every step is idempotent.
#
# Needs:
#   MIGRATE_DATABASE_URL          owner/superuser connection (NEVER the application roles)
#   DERIVDESK_API_DB_PASSWORD     password for role derivdesk_api    (>= 24 chars)
#   DERIVDESK_ADMIN_DB_PASSWORD   password for role derivdesk_admin  (>= 24 chars, different)
# Optional:
#   MIGRATE_ALLOW_PLACEHOLDER_PASSWORDS=1   local development only
set -euo pipefail
cd "$(dirname "$0")/.."

: "${MIGRATE_DATABASE_URL:?MIGRATE_DATABASE_URL is required}"
api_pw="${DERIVDESK_API_DB_PASSWORD:-}"
admin_pw="${DERIVDESK_ADMIN_DB_PASSWORD:-}"

if [[ "${MIGRATE_ALLOW_PLACEHOLDER_PASSWORDS:-0}" != "1" ]]; then
  for pair in "DERIVDESK_API_DB_PASSWORD:$api_pw" "DERIVDESK_ADMIN_DB_PASSWORD:$admin_pw"; do
    name="${pair%%:*}"; value="${pair#*:}"
    if [[ ${#value} -lt 24 || "$value" == *change_me* ]]; then
      echo "REFUSING TO RUN: $name must be set to a random value of at least 24 characters (not a placeholder)." >&2
      exit 64
    fi
  done
  if [[ "$api_pw" == "$admin_pw" ]]; then
    echo "REFUSING TO RUN: the api and admin database passwords must differ — separate deployments, separate credentials." >&2
    exit 64
  fi
fi
[[ -n "$api_pw" && -n "$admin_pw" ]] || { echo "Both role passwords are required." >&2; exit 64; }

psql_owner() { psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

echo "[1/5] Ensuring application roles exist (with their real passwords — placeholders are never created)"
for spec in "derivdesk_api:$api_pw" "derivdesk_admin:$admin_pw"; do
  role="${spec%%:*}"; pw="${spec#*:}"
  psql_owner -v role="$role" -v pw="$pw" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SQL
done

echo "[2/5] Applying migrations (prisma migrate deploy — applies only what is pending, never resets)"
DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy --schema packages/db/prisma/schema.prisma

echo "[3/5] Applying roles and grants (infra/db-init/001_roles.sql)"
psql_owner -f infra/db-init/001_roles.sql

echo "[4/5] Setting role passwords (so a rotated secret takes effect on the next deploy)"
for spec in "derivdesk_api:$api_pw" "derivdesk_admin:$admin_pw"; do
  role="${spec%%:*}"; pw="${spec#*:}"
  printf 'SELECT format(%s, :'"'"'role'"'"', :'"'"'pw'"'"') \\gexec\n' "'ALTER ROLE %I PASSWORD %L'" | psql_owner -v role="$role" -v pw="$pw"
done

echo "[5/5] Verifying the privilege boundary that the whole admin/client separation rests on"
verdict="$(psql_owner -At <<'SQL'
SELECT CASE WHEN
      NOT has_table_privilege('derivdesk_admin', 'deriv_oauth_tokens', 'SELECT')
  AND NOT has_table_privilege('derivdesk_admin', 'users',              'SELECT')
  AND NOT has_table_privilege('derivdesk_admin', 'bot_instances',      'SELECT')
  AND NOT has_table_privilege('derivdesk_admin', 'runner_leases',      'SELECT')
  AND NOT has_table_privilege('derivdesk_api',   'admin_users',        'SELECT')
  AND NOT has_table_privilege('derivdesk_api',   'audit_logs',         'UPDATE')
  AND NOT has_table_privilege('derivdesk_api',   'audit_logs',         'DELETE')
  AND     has_table_privilege('derivdesk_api',   'deriv_oauth_tokens', 'SELECT')
  AND     has_table_privilege('derivdesk_api',   'runner_leases',      'INSERT')
THEN 'ok' ELSE 'VIOLATED' END;
SQL
)"
if [[ "$verdict" != "ok" ]]; then
  echo "PRIVILEGE BOUNDARY CHECK FAILED — refusing to let the apps start against this database." >&2
  exit 70
fi
echo "Database is at the expected schema; roles and boundary verified."
