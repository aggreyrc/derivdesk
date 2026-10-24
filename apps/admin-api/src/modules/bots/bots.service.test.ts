import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { Prisma } from "@derivdesk/db";
import { createStrategy, deleteStrategy, getStrategy, listStrategies, setStrategyStatus, updateStrategy } from "./bots.service.js";
import type { StrategyDefinition } from "./strategy.schema.js";

function fakeAudit() {
  return vi.fn().mockResolvedValue(undefined);
}

function fakeDb(overrides: Record<string, unknown> = {}) {
  return {
    botStrategy: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      ...overrides,
    },
  } as unknown as PrismaClient;
}

const actor = { adminId: "admin_1", adminEmail: "ops@example.com" };

const minimalDefinition: StrategyDefinition = {
  candleGranularitySeconds: 60,
  indicators: [{ id: "rsi_14", type: "RSI", period: 14 }],
  entryRules: [{ contractType: "CALL", when: { left: { kind: "indicator", id: "rsi_14" }, operator: "LT", right: { kind: "constant", value: 30 } } }],
  staking: { mode: "FIXED", stake: 1 },
  riskLimits: {},
  tradeParams: { durationValue: 5, durationUnit: "t" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listStrategies", () => {
  it("rejects an invalid status filter before querying the db", async () => {
    const db = fakeDb();
    await expect(listStrategies({ db, audit: fakeAudit() }, "NOT_A_STATUS")).rejects.toMatchObject({ status: 400 });
    expect(db.botStrategy.findMany).not.toHaveBeenCalled();
  });

  it("passes a valid status filter through to the db", async () => {
    const db = fakeDb();
    await listStrategies({ db, audit: fakeAudit() }, "PUBLISHED");
    expect(db.botStrategy.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "PUBLISHED" } }));
  });
});

describe("getStrategy", () => {
  it("404s when the strategy doesn't exist", async () => {
    const db = fakeDb({ findUnique: vi.fn().mockResolvedValue(null) });
    await expect(getStrategy({ db, audit: fakeAudit() }, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("createStrategy", () => {
  it("always creates as DRAFT regardless of what's passed, and audits it", async () => {
    const db = fakeDb({ create: vi.fn().mockResolvedValue({ id: "s1", key: "k", name: "n", status: "DRAFT" }) });
    const audit = fakeAudit();

    await createStrategy({ db, audit }, actor, { key: "k", name: "n", description: "d", definition: minimalDefinition });

    expect(db.botStrategy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DRAFT", createdBy: "admin_1" }) }),
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bot_strategy.created" }));
  });

  it("surfaces a duplicate key as a 409, not a raw db error", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5.22.0" });
    const db = fakeDb({ create: vi.fn().mockRejectedValue(conflict) });

    await expect(
      createStrategy({ db, audit: fakeAudit() }, actor, { key: "taken", name: "n", description: "d", definition: minimalDefinition }),
    ).rejects.toMatchObject({ status: 409, code: "StrategyKeyTaken" });
  });
});

describe("updateStrategy", () => {
  it("rejects an empty patch", async () => {
    const db = fakeDb();
    await expect(updateStrategy({ db, audit: fakeAudit() }, actor, "s1", {})).rejects.toMatchObject({ status: 400 });
    expect(db.botStrategy.update).not.toHaveBeenCalled();
  });

  it("404s on an unknown id instead of a raw db error", async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError("missing", { code: "P2025", clientVersion: "5.22.0" });
    const db = fakeDb({ update: vi.fn().mockRejectedValue(notFound) });

    await expect(updateStrategy({ db, audit: fakeAudit() }, actor, "missing", { name: "new name" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("setStrategyStatus", () => {
  it("writes the new status and audits the transition", async () => {
    const db = fakeDb({ update: vi.fn().mockResolvedValue({ id: "s1", status: "PUBLISHED" }) });
    const audit = fakeAudit();

    await setStrategyStatus({ db, audit }, actor, "s1", "PUBLISHED");

    expect(db.botStrategy.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "PUBLISHED" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bot_strategy.status_changed", metadata: { status: "PUBLISHED" } }));
  });
});

describe("deleteStrategy", () => {
  it("refuses to delete a strategy that's in use (FK restrict), as a clear 409", async () => {
    const restricted = new Prisma.PrismaClientKnownRequestError("fk violation", { code: "P2003", clientVersion: "5.22.0" });
    const db = fakeDb({ delete: vi.fn().mockRejectedValue(restricted) });

    await expect(deleteStrategy({ db, audit: fakeAudit() }, actor, "s1")).rejects.toMatchObject({ status: 409, code: "StrategyInUse" });
  });

  it("deletes an unused strategy and audits it", async () => {
    const db = fakeDb({ delete: vi.fn().mockResolvedValue({ id: "s1" }) });
    const audit = fakeAudit();

    await deleteStrategy({ db, audit }, actor, "s1");

    expect(db.botStrategy.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bot_strategy.deleted" }));
  });
});
