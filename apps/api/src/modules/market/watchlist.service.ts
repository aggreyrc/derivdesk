import type { PrismaClient } from "@derivdesk/db";

// One "Default" watchlist per user, created lazily. The schema (packages/db) supports named,
// multiple watchlists per user for later; the Phase 4 UI only needs one, so we don't expose
// list-management complexity the UI can't act on yet.
async function getOrCreateDefaultWatchlist(db: PrismaClient, userId: string) {
  const existing = await db.watchlist.findFirst({ where: { userId, name: "Default" } });
  if (existing) return existing;
  return db.watchlist.create({ data: { userId, name: "Default" } });
}

export async function listWatchlistSymbols(db: PrismaClient, userId: string): Promise<string[]> {
  const watchlist = await db.watchlist.findFirst({
    where: { userId, name: "Default" },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  return watchlist?.items.map((i) => i.symbol) ?? [];
}

export async function addToWatchlist(db: PrismaClient, userId: string, symbol: string): Promise<string[]> {
  const watchlist = await getOrCreateDefaultWatchlist(db, userId);
  const existing = await db.watchlistItem.findFirst({ where: { watchlistId: watchlist.id, symbol } });
  if (!existing) {
    const count = await db.watchlistItem.count({ where: { watchlistId: watchlist.id } });
    await db.watchlistItem.create({ data: { watchlistId: watchlist.id, symbol, sortOrder: count } });
  }
  return listWatchlistSymbols(db, userId);
}

export async function removeFromWatchlist(db: PrismaClient, userId: string, symbol: string): Promise<string[]> {
  const watchlist = await db.watchlist.findFirst({ where: { userId, name: "Default" } });
  if (watchlist) {
    // Scoped by watchlistId (itself scoped to this userId above) — a symbol string alone
    // never lets one user touch another user's row.
    await db.watchlistItem.deleteMany({ where: { watchlistId: watchlist.id, symbol } });
  }
  return listWatchlistSymbols(db, userId);
}
