// Operator command: re-encrypt all admins' TOTP state under the current ADMIN_TOTP_ENCRYPTION_KEY.
//   docker compose exec admin-api npm run rotate-totp-key -- --dry-run
//   docker compose exec admin-api npm run rotate-totp-key
// Procedure: docs/operations.md "Rotating the encryption keys". Prints counts and row ids only.
import { PrismaClient } from "@derivdesk/db";
import { keyring } from "../src/lib/crypto.js";
import { rotateTotpKeys, type RotationDb } from "../src/lib/keyRotation.js";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");
const report = await rotateTotpKeys(prisma as unknown as RotationDb, keyring, { dryRun });
console.log(JSON.stringify({ dryRun, ...report }, null, 2));
await prisma.$disconnect();

if (report.undecryptableRowIds.length > 0) {
  console.error("Some values could not be decrypted with ANY configured key (ids above). Do NOT retire the old key until this is explained.");
  process.exit(2);
}
if (report.raced > 0) {
  console.error("Some rows changed while rotating. Run the command again until `raced` is 0.");
  process.exit(3);
}
