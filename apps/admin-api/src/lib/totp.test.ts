import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpStep, verifyTotp } from "./totp.js";

// RFC 4226 Appendix D test vectors (secret "12345678901234567890", 6 digits).
const RFC4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
// RFC 6238 Appendix B (SHA-1, 8 digits) — checked at 6 digits by taking the last 6.
const RFC6238: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
];
const ASCII_SECRET = Buffer.from("12345678901234567890");

describe("hotp / totp against the published RFC vectors", () => {
  it.each(RFC4226.map((code, i) => [i, code] as const))("RFC 4226 counter %i -> %s", (counter, code) => {
    expect(hotp(ASCII_SECRET, counter)).toBe(code);
  });

  it.each(RFC6238)("RFC 6238 at t=%i -> %s (8 digits)", (t, code) => {
    expect(hotp(ASCII_SECRET, Math.floor(t / 30), 8)).toBe(code);
  });
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 17, 99]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("matches the RFC 4648 vector", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
  });

  it("is tolerant of case, spaces and padding when decoding, and rejects junk", () => {
    expect(base32Decode("mzxw 6ytb oi==").toString()).toBe("foobar");
    expect(() => base32Decode("not-base32!")).toThrow();
  });
});

describe("generateTotpSecret", () => {
  it("makes 160-bit base32 secrets that differ each time", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(ASCII_SECRET);
  const now = 1234567890 * 1000;
  const code = hotp(ASCII_SECRET, totpStep(now));

  it("returns the matching step", () => expect(verifyTotp(secret, code, now)).toBe(totpStep(now)));
  it("accepts ±1 step and no more", () => {
    expect(verifyTotp(secret, hotp(ASCII_SECRET, totpStep(now) - 1), now)).toBe(totpStep(now) - 1);
    expect(verifyTotp(secret, hotp(ASCII_SECRET, totpStep(now) + 1), now)).toBe(totpStep(now) + 1);
    expect(verifyTotp(secret, hotp(ASCII_SECRET, totpStep(now) + 2), now)).toBeNull();
  });
  it.each(["", "12345", "1234567", "12345a", " 123456", "١٢٣٤٥٦"])("rejects malformed code %j", (bad) => expect(verifyTotp(secret, bad, now)).toBeNull());
});

describe("otpauthUri", () => {
  it("builds a standard provisioning URI", () => {
    const uri = otpauthUri("ops@example.com", "JBSWY3DPEHPK3PXP");
    expect(uri.startsWith("otpauth://totp/DerivDesk%20Admin%3Aops%40example.com?")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
