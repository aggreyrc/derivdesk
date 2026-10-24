import { describe, expect, it } from "vitest";
import { codeChallengeS256, generateCodeVerifier, generateState } from "../pkce.js";

describe("PKCE helpers", () => {
  it("generates a verifier of a valid RFC 7636 length", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("derives a deterministic S256 challenge from a verifier", () => {
    // RFC 7636 Appendix B worked example
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates unpredictable, distinct state values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});
