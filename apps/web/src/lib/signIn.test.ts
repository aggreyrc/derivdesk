import { describe, expect, it } from "vitest";
import { deriveErrorMessage, signInUrl } from "./signIn";

describe("signInUrl", () => {
  it("is the API's Deriv login endpoint (same origin when the base is empty)", () => {
    expect(signInUrl("")).toBe("/api/deriv/login");
    expect(signInUrl("http://localhost:4000")).toBe("http://localhost:4000/api/deriv/login");
    expect(signInUrl("http://localhost:4000/")).toBe("http://localhost:4000/api/deriv/login");
  });
});

describe("deriveErrorMessage", () => {
  it("returns nothing when there was no error", () => {
    expect(deriveErrorMessage(null)).toBeNull();
    expect(deriveErrorMessage("")).toBeNull();
  });

  it("has a plain-language message for every code the API can send", () => {
    for (const code of ["access_denied", "state_mismatch", "expired", "exchange_failed", "accounts_failed", "no_accounts", "account_conflict", "account_mismatch", "suspended", "not_configured", "unknown"]) {
      const msg = deriveErrorMessage(code)!;
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toMatch(/[a-z]+_[a-z]+/); // never shows a raw machine code like account_conflict to the person
    }
  });

  it("treats anything else — including hostile values in the URL — as the generic message, never echoing it", () => {
    const generic = deriveErrorMessage("unknown");
    for (const evil of ["<script>alert(1)</script>", "__proto__", "constructor", "toString", "hasOwnProperty", "nope"]) {
      expect(deriveErrorMessage(evil)).toBe(generic);
    }
  });
});
