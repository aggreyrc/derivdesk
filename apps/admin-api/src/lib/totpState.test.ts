import { describe, expect, it } from "vitest";
import { sealTotpState, unsealTotpState } from "./totpState.js";
import { encryptWithKey } from "./crypto.js";

describe("totpState", () => {
  it("round-trips and never stores the secret in the clear", () => {
    const blob = sealTotpState({ v: 1, secret: "JBSWY3DPEHPK3PXP", lastStep: 42 });
    expect(blob).not.toContain("JBSWY3DPEHPK3PXP");
    expect(unsealTotpState(blob)).toEqual({ v: 1, secret: "JBSWY3DPEHPK3PXP", lastStep: 42 });
  });

  it("re-sealing the same state gives a different ciphertext (fresh IV)", () => {
    const s = { v: 1 as const, secret: "AAAA", lastStep: null };
    expect(sealTotpState(s)).not.toBe(sealTotpState(s));
  });

  it("refuses a blob sealed with a different key (e.g. apps/api's client-token key)", () => {
    const foreign = encryptWithKey(JSON.stringify({ v: 1, secret: "AAAA", lastStep: null }), Buffer.alloc(32, 7));
    expect(() => unsealTotpState(foreign)).toThrow();
  });

  it("refuses a tampered blob", () => {
    const blob = sealTotpState({ v: 1, secret: "AAAA", lastStep: null });
    const parts = blob.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("AA") ? "BB" : "AA");
    expect(() => unsealTotpState(parts.join("."))).toThrow();
  });
});
