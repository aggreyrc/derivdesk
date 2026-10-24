-- Phase 3: Deriv connection state.
-- (Hand-authored like the init migration — regenerate/diff with `prisma migrate dev`
-- once you have normal network access; see README.)

-- One Deriv connection per app user, with a re-auth flag.
DROP INDEX "deriv_oauth_tokens_user_id_idx";
CREATE UNIQUE INDEX "deriv_oauth_tokens_user_id_key" ON "deriv_oauth_tokens"("user_id");
ALTER TABLE "deriv_oauth_tokens" ADD COLUMN "needs_reauth" BOOLEAN NOT NULL DEFAULT false;

-- Active Deriv account per session (nullable; cleared if the account row is deleted).
ALTER TABLE "sessions" ADD COLUMN "active_deriv_account_id" TEXT;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_deriv_account_id_fkey"
  FOREIGN KEY ("active_deriv_account_id") REFERENCES "deriv_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
