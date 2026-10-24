-- Deriv-only sign-up: a user is created by signing in with Deriv and nothing else.
--
-- EXPAND step only (non-destructive, rollback-safe — see docs/operations.md §3):
--   * users.email and users.password_hash become nullable (legacy; no longer written);
--   * users.handle (required, unique) is the human-readable identifier — the primary Deriv account id;
--   * deriv_accounts.deriv_account_id becomes globally unique: one Deriv account <-> one app user.
-- A later "contract" migration drops the legacy columns once nothing reads them.
--
-- NOTE: hand-authored like the earlier migrations (this sandbox cannot reach binaries.prisma.sh);
-- regenerate/diff with `prisma migrate dev` from a normal environment.

-- 1. Refuse to continue if one Deriv account is attached to more than one app user. That can only
--    have happened if the same Deriv account was connected from two email sign-ups; which user
--    should keep it is a human decision, so the migration stops rather than guess.
DO $$
DECLARE dup TEXT;
BEGIN
  SELECT string_agg(deriv_account_id, ', ') INTO dup FROM (
    SELECT deriv_account_id FROM "deriv_accounts" GROUP BY deriv_account_id HAVING count(*) > 1 LIMIT 10
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot make deriv_accounts.deriv_account_id unique: attached to several users (e.g. %). Merge or remove the duplicate users first.', dup;
  END IF;
END $$;

-- 2. Legacy columns become optional.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- 3. handle: backfill existing rows (prefer a REAL Deriv account id, then any, then the old email,
--    then the row id so it is always unique and non-null), then make it required + unique.
ALTER TABLE "users" ADD COLUMN "handle" TEXT;
UPDATE "users" u SET "handle" = COALESCE(
  (SELECT a.deriv_account_id FROM "deriv_accounts" a WHERE a.user_id = u.id
     ORDER BY (a.account_type = 'REAL') DESC, a.deriv_account_id LIMIT 1),
  u."email",
  u."id"
);
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- 4. One Deriv account <-> one app user.
CREATE UNIQUE INDEX "deriv_accounts_deriv_account_id_key" ON "deriv_accounts"("deriv_account_id");
