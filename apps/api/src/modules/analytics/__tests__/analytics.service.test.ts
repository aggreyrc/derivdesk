import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DerivAccount, PrismaClient } from "@derivdesk/db";
import { clearAnalyticsCache, displayDecimals, getPerformance, getSummary, MAX_TRADES } from "../analytics.service.js";

const account = { id: "acc_1", userId: "user_1", derivAccountId: "VRTC1", accountType: "DEMO", currency: "USD", status: "active" } as unknown as DerivAccount;
const NOW = 1_800_000_000_000; // ms

const row = (id: number, buy = 1, sell = 2) => ({ contract_id: id, transaction_id: id, purchase_time: NOW / 1000 - 100, sell_time: NOW / 1000 - 50, buy_price: buy, sell_price: sell, underlying_symbol: "R_100", contract_type: "CALL" });

function setup(pages: unknown[][], bots: { instances?: { id: string }[]; trades?: { contractId: string }[] } = {}) {
  const getProfitTable = vi.fn();
  pages.forEach((p) => getProfitTable.mockResolvedValueOnce(p));
  getProfitTable.mockResolvedValue([]);
  const db = {
    botInstance: { findMany: vi.fn().mockResolvedValue(bots.instances ?? []) },
    botTrade: { findMany: vi.fn().mockResolvedValue(bots.trades ?? []) },
  } as unknown as PrismaClient;
  return { deps: { db, trading: { getProfitTable } as never, now: () => NOW }, getProfitTable, db };
}

beforeEach(() => clearAnalyticsCache());

describe("analytics service", () => {
  it("asks Deriv for descriptions with a pinned date_to and the period's date_from", async () => {
    const { deps, getProfitTable } = setup([[row(1)]]);
    await getSummary(deps, "user_1", account, "7d");
    expect(getProfitTable).toHaveBeenCalledWith("user_1", "VRTC1", 500, { offset: 0, sort: "DESC", dateFrom: NOW / 1000 - 7 * 86_400, dateTo: NOW / 1000, description: true });
  });

  it("'all' sends no date_from", async () => {
    const { deps, getProfitTable } = setup([[row(1)]]);
    await getSummary(deps, "user_1", account, "all");
    expect(getProfitTable.mock.calls[0]![3]).not.toHaveProperty("dateFrom", expect.anything());
    expect(getProfitTable.mock.calls[0]![3].dateFrom).toBeUndefined();
  });

  it("pages until a short page, and reports meta honestly (demo label, counts)", async () => {
    const full = Array.from({ length: 500 }, (_, i) => row(i + 1));
    const { deps, getProfitTable } = setup([full, [row(900), { contract_id: null, transaction_id: 1, purchase_time: 1, sell_time: null, buy_price: 1 }]]);
    const { meta, summary } = await getSummary(deps, "user_1", account, "30d");
    expect(getProfitTable).toHaveBeenCalledTimes(2);
    expect(getProfitTable.mock.calls[1]![3].offset).toBe(500);
    expect(meta).toMatchObject({ accountType: "DEMO", currency: "USD", decimals: 2, tradesAnalyzed: 501, excludedRows: 1, truncated: false });
    expect(summary.tradesCount).toBe(501);
  });

  it("stops at the cap and flags the result as truncated", async () => {
    const full = () => Array.from({ length: 500 }, (_, i) => row(i + 1));
    const { deps, getProfitTable } = setup([full(), full(), full(), full()]);
    const { meta } = await getSummary(deps, "user_1", account, "all");
    expect(getProfitTable).toHaveBeenCalledTimes(MAX_TRADES / 500);
    expect(meta.truncated).toBe(true);
  });

  it("tags trades whose contract id belongs to one of the user's bots", async () => {
    const { deps, db } = setup([[row(1), row(2, 1, 0)]], { instances: [{ id: "bot_1" }], trades: [{ contractId: "2" }] });
    const perf = await getPerformance(deps, "user_1", account, "30d");
    expect(db.botInstance.findMany).toHaveBeenCalledWith({ where: { userId: "user_1", derivAccountId: "acc_1" } });
    expect(perf.bySource.find((r) => r.key === "Bot")).toMatchObject({ tradesCount: 1, netPnl: -1 });
    expect(perf.bySource.find((r) => r.key === "Manual")).toMatchObject({ tradesCount: 1, netPnl: 1 });
  });

  it("serves summary and performance from one Deriv fetch (cache) within the TTL", async () => {
    const { deps, getProfitTable } = setup([[row(1)]]);
    await getSummary(deps, "user_1", account, "30d");
    await getPerformance(deps, "user_1", account, "30d");
    expect(getProfitTable).toHaveBeenCalledTimes(1);
  });

  it("never shares a cache entry between users or accounts", async () => {
    const { deps, getProfitTable } = setup([[row(1)], [row(2)]]);
    await getSummary(deps, "user_1", account, "30d");
    await getSummary(deps, "user_2", account, "30d");
    expect(getProfitTable).toHaveBeenCalledTimes(2);
  });

  it("uses more decimals for crypto currencies", () => {
    expect(displayDecimals("usd")).toBe(2);
    expect(displayDecimals("BTC")).toBe(8);
  });
});
