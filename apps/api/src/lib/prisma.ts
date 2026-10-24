import { PrismaClient } from "@derivdesk/db";

// A single PrismaClient instance per process, connecting as the
// least-privileged `derivdesk_api` role (see infra/db-init/001_roles.sql).
// This client has no visibility into admin_users/admin_sessions at all —
// that isolation is enforced by Postgres, not by convention here.
export const prisma = new PrismaClient();
