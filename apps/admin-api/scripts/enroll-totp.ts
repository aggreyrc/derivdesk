// Run with: npm run enroll-totp --workspace apps/admin-api -- --email you@example.com
//
// Enrols (or RE-enrols) an admin's authenticator app. Like create-admin there is deliberately no
// HTTP endpoint for it: whoever can run this has shell access to the deployment, which is exactly
// the trust boundary the separate admin deployment is for. It is also the account-recovery path
// for a lost phone — re-running it replaces the secret and signs the admin out everywhere.
//
// The secret is printed ONCE, here. It is stored only encrypted (ADMIN_TOTP_ENCRYPTION_KEY).
import "dotenv/config";
import { PrismaClient } from "@derivdesk/db";
import { generateTotpSecret, otpauthUri } from "../src/lib/totp.js";
import { sealTotpState } from "../src/lib/totpState.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: --email <admin email>");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin) {
      console.error(`No admin with email ${email}. Create one first: npm run create-admin`);
      process.exit(1);
    }

    const secret = generateTotpSecret();
    await prisma.adminUser.update({ where: { id: admin.id }, data: { totpSecretEnc: sealTotpState({ v: 1, secret, lastStep: null }) } });
    const revoked = await prisma.adminSession.deleteMany({ where: { adminUserId: admin.id } });

    console.log(`Authenticator enrolled for ${email}. (${revoked.count} existing session(s) signed out.)\n`);
    console.log("Add it to an authenticator app (Google Authenticator, Authy, 1Password, Aegis…):");
    console.log(`  setup key : ${secret}`);
    console.log(`  otpauth   : ${otpauthUri(email, secret)}\n`);
    console.log("This is the only time the secret is shown. Sign-in now requires a 6-digit code.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
