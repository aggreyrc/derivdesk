import type { Keyring } from "./crypto.js";

// Re-encrypts every stored Deriv token under the CURRENT key (TOKEN_ENCRYPTION_KEY), so an old key
// can be retired. Safe to run while the app is serving traffic and safe to re-run:
//  - a value the current key already opens is left untouched (idempotent);
//  - each row is updated with a compare-and-set on the exact blobs that were read, so a concurrent
//    token refresh by the app is never overwritten with stale data (counted as `raced`; re-run);
//  - a value NO configured key can open is reported by row id only and never modified — that is a
//    data problem to investigate, not something to guess at;
//  - nothing sensitive is ever returned or logged: only counts and row ids.

export interface TokenRow {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
}

export interface RotationDb {
  derivOAuthToken: {
    findMany(args: { where?: { id: { gt: string } }; orderBy: { id: "asc" }; take: number; select: { id: true; accessTokenEnc: true; refreshTokenEnc: true } }): Promise<TokenRow[]>;
    updateMany(args: { where: { id: string; accessTokenEnc: string; refreshTokenEnc: string | null }; data: { accessTokenEnc: string; refreshTokenEnc: string | null } }): Promise<{ count: number }>;
  };
}

export interface RotationReport {
  scanned: number;
  alreadyCurrent: number;
  rotated: number; // (or would be, with dryRun)
  raced: number;
  undecryptableRowIds: string[];
}

export async function rotateTokenKeys(db: RotationDb, keyring: Keyring, opts: { dryRun?: boolean; batchSize?: number } = {}): Promise<RotationReport> {
  const batchSize = opts.batchSize ?? 200;
  const report: RotationReport = { scanned: 0, alreadyCurrent: 0, rotated: 0, raced: 0, undecryptableRowIds: [] };
  let cursor: string | undefined;

  for (;;) {
    const rows = await db.derivOAuthToken.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, accessTokenEnc: true, refreshTokenEnc: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      report.scanned++;
      const accessCurrent = keyring.isCurrent(row.accessTokenEnc);
      const refreshCurrent = row.refreshTokenEnc === null || keyring.isCurrent(row.refreshTokenEnc);
      if (accessCurrent && refreshCurrent) {
        report.alreadyCurrent++;
        continue;
      }

      let next: { accessTokenEnc: string; refreshTokenEnc: string | null };
      try {
        next = {
          accessTokenEnc: accessCurrent ? row.accessTokenEnc : keyring.encrypt(keyring.decrypt(row.accessTokenEnc)),
          refreshTokenEnc: row.refreshTokenEnc === null || refreshCurrent ? row.refreshTokenEnc : keyring.encrypt(keyring.decrypt(row.refreshTokenEnc)),
        };
      } catch {
        report.undecryptableRowIds.push(row.id);
        continue;
      }

      if (opts.dryRun) {
        report.rotated++;
        continue;
      }
      const { count } = await db.derivOAuthToken.updateMany({
        where: { id: row.id, accessTokenEnc: row.accessTokenEnc, refreshTokenEnc: row.refreshTokenEnc },
        data: next,
      });
      if (count === 1) report.rotated++;
      else report.raced++;
    }
    if (rows.length < batchSize) break;
  }
  return report;
}
