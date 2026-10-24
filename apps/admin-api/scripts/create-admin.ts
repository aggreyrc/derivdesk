// Run with: npm run create-admin --workspace apps/admin-api -- --email you@example.com --password "..."
//
// There is deliberately no HTTP endpoint for this. Admin accounts are
// provisioned by whoever has shell/deploy access to this service, which is
// exactly the trust boundary a "fully separate admin deployment" is for.
import "dotenv/config";
import { PrismaClient } from "@derivdesk/db";
import bcrypt from "bcryptjs";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase(); // login lower-cases emails, so store them that way
  const password = arg("password");

  if (!email || !password || password.length < 12) {
    console.error("Usage: --email <email> --password <at least 12 chars>");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.adminUser.upsert({
      where: { email },
      update: { passwordHash },
      create: { email, passwordHash },
    });
    console.log(`Admin user ready: ${admin.email} (${admin.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
