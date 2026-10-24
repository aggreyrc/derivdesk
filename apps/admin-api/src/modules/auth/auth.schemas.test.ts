import { describe, expect, it } from "vitest";
import { adminLoginSchema } from "./auth.schemas.js";

describe("adminLoginSchema", () => {
  it("normalises the email and accepts an optional 6-digit code", () => {
    const r = adminLoginSchema.parse({ email: " Ops@Example.COM ", password: "x", totpCode: " 123456 " });
    expect(r).toEqual({ email: "ops@example.com", password: "x", totpCode: "123456" });
  });
  it.each(["12345", "1234567", "abcdef", "12 456"])("rejects a malformed code %j", (c) => {
    expect(adminLoginSchema.safeParse({ email: "a@b.co", password: "x", totpCode: c }).success).toBe(false);
  });
  it("allows the code to be absent", () => {
    expect(adminLoginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });
});
