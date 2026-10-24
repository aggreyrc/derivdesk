import { describe, expect, it, vi } from "vitest";
import { sealFlowState, statesMatch, unsealFlowState } from "../oauthState.js";

describe("sealFlowState / unsealFlowState", () => {
  it("round-trips flow state", () => {
    const flow = { state: "abc", codeVerifier: "verifier", userId: "user_1", createdAt: Date.now() };
    const sealed = sealFlowState(flow);
    expect(unsealFlowState(sealed)).toEqual(flow);
  });

  it("rejects a tampered cookie value", () => {
    const sealed = sealFlowState({ state: "abc", codeVerifier: "v", userId: "user_1", createdAt: Date.now() });
    const parts = sealed.split(".");
    const last = parts[3]!;
    parts[3] = last.slice(0, -2) + (last.slice(-2) === "AA" ? "BB" : "AA");
    expect(unsealFlowState(parts.join("."))).toBeNull();
  });

  it("rejects an expired flow", () => {
    const old = Date.now() - 11 * 60 * 1000; // TTL is 10 minutes
    const sealed = sealFlowState({ state: "abc", codeVerifier: "v", userId: "user_1", createdAt: old });
    expect(unsealFlowState(sealed)).toBeNull();
  });

  it("rejects garbage input without throwing", () => {
    expect(unsealFlowState("not-a-real-sealed-value")).toBeNull();
  });
});

describe("statesMatch", () => {
  it("is true only for an exact match", () => {
    expect(statesMatch("abc123", "abc123")).toBe(true);
    expect(statesMatch("abc123", "abc124")).toBe(false);
    expect(statesMatch("abc123", undefined)).toBe(false);
    expect(statesMatch("abc123", 42)).toBe(false);
  });
});
