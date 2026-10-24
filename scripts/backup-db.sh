#!/usr/bin/env bash
# Logical backup of the DerivDesk database. Run from cron on the Docker host, e.g. every 6 hours:
#   0 */6 * * *  cd /opt/derivdesk && scripts/backup-db.sh >> /var/log/derivdesk-backup.log 2>&1
#
# What you get: a pg_dump custom-format archive (compressed, restorable selectively) that is VERIFIED
# readable before the script reports success, written 0600, optionally GPG-encrypted, with old
# backups pruned. A backup that was never read back is not a backup.
#
# IMPORTANT — what a backup does NOT contain: the encryption keys. The dump holds Deriv tokens and
# admin TOTP secrets only in ENCRYPTED form; without TOKEN_ENCRYPTION_KEY / ADMIN_TOTP_ENCRYPTION_KEY
# the restored data cannot be decrypted (users would have to reconnect Deriv, admins re-enrol 2FA).
# Store those keys in a password manager/secret store, SEPARATE from where these backups live —
# keeping both together would defeat the encryption.
#
# Settings (environment):
#   BACKUP_DIR              default ./backups
#   BACKUP_KEEP_DAYS        default 14 (0 = never prune)
#   BACKUP_GPG_RECIPIENT    if set, the archive is encrypted to this key and the plaintext removed
#   COMPOSE_FILE            default docker-compose.prod.yml
#   DB_NAME                 default derivdesk
#   DIRECT_PG=1 PGURL=...   skip Docker and use local pg_dump against this superuser URL (tests, managed DB)
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_NAME="${DB_NAME:-derivdesk}"

if [[ "${DIRECT_PG:-0}" == "1" ]]; then
  : "${PGURL:?PGURL is required with DIRECT_PG=1}"
  dump()    { pg_dump --format=custom --no-owner --dbname "$PGURL"; }
  listing() { pg_restore --list; }
else
  dump()    { docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump --format=custom --no-owner -U postgres -d "$DB_NAME"; }
  listing() { docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list; }
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/derivdesk-$stamp.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

dump > "$tmp"

# Read it back: the table of contents must parse and must contain the tables that matter.
toc="$(listing < "$tmp")" || { echo "BACKUP INVALID: archive is unreadable" >&2; exit 1; }
for table in users deriv_oauth_tokens audit_logs admin_users; do
  grep -Eq "TABLE DATA public $table " <<<"$toc" || { echo "BACKUP INVALID: no data section for table '$table'" >&2; exit 1; }
done

mv "$tmp" "$out"
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$out.gpg" --encrypt "$out"
  rm -f "$out"
  out="$out.gpg"
fi
chmod 600 "$out"

if [[ "$KEEP_DAYS" != "0" ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'derivdesk-*.dump*' -mtime "+$KEEP_DAYS" -print -delete | sed 's/^/pruned: /'
fi
echo "backup ok: $out ($(wc -c < "$out") bytes)"
