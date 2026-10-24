import { PrismaClient } from "@derivdesk/db";

// Connects as `derivdesk_admin`, which Postgres has NOT granted access to
// deriv_oauth_tokens, users, sessions, local_trades, transactions_cache,
// watchlists, or notifications (see infra/db-init/001_roles.sql). The
// generated client technically exposes those models' methods too — Prisma
// doesn't know about per-role grants — but calling them from this app will
// fail at the database with a permission error, not silently succeed.
// Treat that as a bug if it ever happens, not a fallback path to code around.
export const prisma = new PrismaClient();
