import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptWithKey, encryptWithKey } from "../crypto.js";

describe("encryptWithKey / decryptWithKey", () => {
  const key = randomBytes(32);

  it("round-trips a secret", () => {
    const blob = encryptWithKey("super-secret-deriv-token", key);
    expect(blob).not.toContain("super-secret-deriv-token");
    expect(decryptWithKey(blob, key)).toBe("super-secret-deriv-token");
  });

  it("produces a different ciphertext every time (random IV)", () => {
    const a = encryptWithKey("same-plaintext", key);
    const b = encryptWithKey("same-plaintext", key);
    expect(a).not.toBe(b);
  });

  it("rejects a tampered blob instead of returning corrupted data", () => {
    const blob = encryptWithKey("super-secret-deriv-token", key);
    const parts = blob.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.slice(-2) === "AA" ? "BB" : "AA");
    expect(() => decryptWithKey(parts.join("."), key)).toThrow();
  });

  it("refuses to decrypt with the wrong key", () => {
    const blob = encryptWithKey("super-secret-deriv-token", key);
    expect(() => decryptWithKey(blob, randomBytes(32))).toThrow();
  });
});
