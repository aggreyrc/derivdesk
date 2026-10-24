import { describe, expect, it } from "vitest";
import { buildWsUrl } from "./apiBase";

describe("buildWsUrl", () => {
  it("same-origin deployment on https uses wss on the page's own host", () => {
    expect(buildWsUrl("", { protocol: "https:", host: "app.example.com" })).toBe("wss://app.example.com/ws");
  });
  it("same-origin on plain http (local reverse proxy) uses ws and keeps the port", () => {
    expect(buildWsUrl("", { protocol: "http:", host: "localhost:8080" })).toBe("ws://localhost:8080/ws");
  });
  it("separate-origin dev setup maps http→ws and https→wss", () => {
    expect(buildWsUrl("http://localhost:4000", { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:4000/ws");
    expect(buildWsUrl("https://api.example.com", { protocol: "https:", host: "app.example.com" })).toBe("wss://api.example.com/ws");
  });
  it("tolerates a trailing slash on the API base", () => {
    expect(buildWsUrl("http://localhost:4000/", { protocol: "http:", host: "x" })).toBe("ws://localhost:4000/ws");
  });
});
