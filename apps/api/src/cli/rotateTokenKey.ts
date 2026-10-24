// Operator command: re-encrypt all stored Deriv tokens under the current TOKEN_ENCRYPTION_KEY.
//   docker compose exec api node dist/cli/rotateTokenKey.js --dry-run
//   docker compose exec api node dist/cli/rotateTokenKey.js
// Full procedure: docs/operations.md "Rotating the encryption key". Prints counts and row ids only.
import { prisma } from "../lib/prisma.js";
import { keyring } from "../lib/crypto.js";
import { rotateTokenKeys, type RotationDb } from "../lib/keyRotation.js";

const dryRun = process.argv.includes("--dry-run");

const report = await rotateTokenKeys(prisma as unknown as RotationDb, keyring, { dryRun });
console.log(JSON.stringify({ dryRun, ...report }, null, 2));
await prisma.$disconnect();

if (report.undecryptableRowIds.length > 0) {
  console.error("Some values could not be decrypted with ANY configured key (ids above). Do NOT retire the old key until this is explained.");
  process.exit(2);
}
if (report.raced > 0) {
  console.error("Some rows changed while rotating (normal under traffic). Run the command again until `raced` is 0.");
  process.exit(3);
}
