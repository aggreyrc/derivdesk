import type { Keyring } from "./crypto.js";

// Re-encrypts every enrolled admin's TOTP state under the CURRENT ADMIN_TOTP_ENCRYPTION_KEY so an old
// key can be retired. Same guarantees as apps/api's token rotation: idempotent, compare-and-set per
// row (so a login that just advanced the replay counter is never overwritten with a stale blob),
// values no key can open are reported by id and left alone, and nothing sensitive is returned.
// The blob is re-sealed as an opaque string, so the replay counter inside it is preserved exactly.

export interface AdminTotpRow {
  id: string;
  totpSecretEnc: string | null;
}

export interface RotationDb {
  adminUser: {
    findMany(args: { where: { id?: { gt: string }; totpSecretEnc: { not: null } }; orderBy: { id: "asc" }; take: number; select: { id: true; totpSecretEnc: true } }): Promise<AdminTotpRow[]>;
    updateMany(args: { where: { id: string; totpSecretEnc: string }; data: { totpSecretEnc: string } }): Promise<{ count: number }>;
  };
}

export interface RotationReport {
  scanned: number;
  alreadyCurrent: number;
  rotated: number; // (or would be, with dryRun)
  raced: number;
  undecryptableRowIds: string[];
}

export async function rotateTotpKeys(db: RotationDb, keyring: Keyring, opts: { dryRun?: boolean; batchSize?: number } = {}): Promise<RotationReport> {
  const batchSize = opts.batchSize ?? 100;
  const report: RotationReport = { scanned: 0, alreadyCurrent: 0, rotated: 0, raced: 0, undecryptableRowIds: [] };
  let cursor: string | undefined;

  for (;;) {
    const rows = await db.adminUser.findMany({
      where: { ...(cursor ? { id: { gt: cursor } } : {}), totpSecretEnc: { not: null } },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, totpSecretEnc: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      const blob = row.totpSecretEnc;
      if (blob === null) continue;
      report.scanned++;
      if (keyring.isCurrent(blob)) {
        report.alreadyCurrent++;
        continue;
      }
      let next: string;
      try {
        next = keyring.encrypt(keyring.decrypt(blob));
      } catch {
        report.undecryptableRowIds.push(row.id);
        continue;
      }
      if (opts.dryRun) {
        report.rotated++;
        continue;
      }
      const { count } = await db.adminUser.updateMany({ where: { id: row.id, totpSecretEnc: blob }, data: { totpSecretEnc: next } });
      if (count === 1) report.rotated++;
      else report.raced++;
    }
    if (rows.length < batchSize) break;
  }
  return report;
}
