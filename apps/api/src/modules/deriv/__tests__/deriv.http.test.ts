import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level behaviour of Deriv-only sign-up/sign-in through the REAL Express app: which routes
// exist, what the redirects and cookies look like, and where each failure sends the browser.
// The service decision logic itself is covered in deriv.signin.test.ts; here it is stubbed so only
// the wiring is under test.

const h = vi.hoisted(() => {
  Object.assign(process.env, {
    DERIV_CLIENT_ID: "app_test",
    DERIV_OAUTH_REDIRECT_URI: "http://localhost:4000/api/deriv/callback",
    WEB_APP_URL: "http://localhost:5173",
    TRUST_PROXY: "1", // so each test request can come from its own client address (see `get`)
  });
  return {
    callback: null as null | (() => Promise<unknown>),
    session: null as null | { id: string; userId: string; user: { id: string; handle: string; status: string } },
    created: [] as Array<{ userId: string }>,
    lastLogin: [] as string[],
  };
});

vi.mock("../../../lib/prisma.js", () => ({
  prisma: { user: { update: async ({ where }: { where: { id: string } }) => void h.lastLogin.push(where.id) } },
}));
vi.mock("../../../lib/session.js", async (orig) => ({
  ...(await orig<typeof import("../../../lib/session.js")>()),
  createSession: async (userId: string) => {
    h.created.push({ userId });
    return { id: "11111111-2222-3333-4444-555555555555" };
  },
  getActiveSession: async () => h.session,
}));
vi.mock("../deriv.service.js", async (orig) => ({
  ...(await orig<typeof import("../deriv.service.js")>()),
  completeCallback: async () => h.callback!(),
}));

import { createApp } from "../../../app.js";
import { sealFlowState } from "../oauthState.js";
import { ConnectError } from "../deriv.service.js";

const app = createApp();
let ipCounter = 0;
const nextIp = () => `198.51.100.${(++ipCounter % 250) + 1}`;
/** A request from a fresh client address, so the production rate limiter does not interfere. */
const from = (ip = nextIp()) => ({
  get: (path: string) => request(app).get(path).set("X-Forwarded-For", ip),
  post: (path: string) => request(app).post(path).set("X-Forwarded-For", ip),
});
const sealedCookie = (userId: string | null) => `derivdesk_oauth=${encodeURIComponent(sealFlowState({ state: "s1", codeVerifier: "v", userId, createdAt: Date.now() }))}`;
const setCookies = (res: request.Response) => ([] as string[]).concat((res.headers["set-cookie"] as unknown as string[]) ?? []);

beforeEach(() => {
  h.callback = null;
  h.session = null;
  h.created.length = 0;
  h.lastLogin.length = 0;
});

describe("there is no password sign-up or sign-in any more", () => {
  it.each([
    ["POST", "/api/auth/register"],
    ["POST", "/api/auth/login"],
    ["GET", "/api/auth/register"],
  ])("%s %s is gone (404)", async (method, path) => {
    const res = await (from() as any)[method.toLowerCase()](path).send({ email: "a@b.co", password: "correct horse battery" });
    expect(res.status).toBe(404);
    expect(setCookies(res).join(";")).not.toMatch(/derivdesk_session/); // and certainly issues no session
  });
});

describe("GET /api/deriv/login — the only way in", () => {
  it("redirects the browser to Deriv with PKCE + state, and seals the flow in an HttpOnly Lax cookie", async () => {
    const res = await from().get("/api/deriv/login");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location!);
    expect(loc.origin + loc.pathname).toBe("https://auth.deriv.com/oauth2/auth");
    expect(loc.searchParams.get("client_id")).toBe("app_test");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("code_verifier")).toBeNull(); // the verifier never leaves the server

    const oauth = setCookies(res).find((c) => c.startsWith("derivdesk_oauth="))!;
    expect(oauth).toMatch(/HttpOnly/i);
    expect(oauth).toMatch(/SameSite=Lax/i);
    expect(oauth).toMatch(/Path=\/api\/deriv/);
    expect(oauth).not.toContain(loc.searchParams.get("state")!); // sealed (encrypted), not readable
  });

  it("needs no session — it is what creates one", async () => {
    expect((await from().get("/api/deriv/login")).status).toBe(302);
  });

  it("is rate limited per client address (so it cannot be used to hammer Deriv or fill the log)", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await from(ip).get("/api/deriv/login")).status);
    expect(statuses.slice(0, 10).every((x) => x === 302)).toBe(true);
    expect(statuses.slice(10).every((x) => x === 429)).toBe(true);
    expect((await from().get("/api/deriv/login")).status).toBe(302); // another address is unaffected
  });

  it("does not start a new flow state that a different browser could reuse", async () => {
    const a = await from().get("/api/deriv/login");
    const b = await from().get("/api/deriv/login");
    expect(new URL(a.headers.location!).searchParams.get("state")).not.toBe(new URL(b.headers.location!).searchParams.get("state"));
  });
});

describe("GET /api/deriv/callback — sign-up / sign-in", () => {
  it("a NEW Deriv user: session cookie issued, browser sent to the app with welcome=new", async () => {
    h.callback = async () => ({ kind: "signed_in", userId: "user_new", handle: "CR100", isNewUser: true });
    const res = await from().get("/api/deriv/callback?code=abc&state=s1").set("Cookie", sealedCookie(null));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("http://localhost:5173/?welcome=new");
    const session = setCookies(res).find((c) => c.startsWith("derivdesk_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(h.created).toEqual([{ userId: "user_new" }]); // the id comes from the verified service result
    expect(h.lastLogin).toEqual(["user_new"]);
    expect(setCookies(res).find((c) => c.startsWith("derivdesk_oauth="))).toMatch(/Expires=Thu, 01 Jan 1970/); // flow cookie is single use
  });

  it("a RETURNING Deriv user is welcomed back", async () => {
    h.callback = async () => ({ kind: "signed_in", userId: "user_1", handle: "CR100", isNewUser: false });
    const res = await from().get("/api/deriv/callback?code=abc&state=s1").set("Cookie", sealedCookie(null));
    expect(res.headers.location).toBe("http://localhost:5173/?welcome=back");
  });

  it.each(["account_conflict", "suspended", "no_accounts", "exchange_failed", "state_mismatch"] as const)(
    "a failed sign-in (%s) lands on the LOGIN page with a code, and no session is issued",
    async (code) => {
      h.callback = async () => {
        throw new ConnectError(code);
      };
      const res = await from().get("/api/deriv/callback?code=abc&state=s1").set("Cookie", sealedCookie(null));
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`http://localhost:5173/login?deriv_error=${code}`);
      expect(setCookies(res).some((c) => c.startsWith("derivdesk_session=") && !/Expires=Thu, 01 Jan 1970/.test(c))).toBe(false);
      expect(h.created).toHaveLength(0);
    },
  );

  it("an unexpected error never leaks details — just deriv_error=unknown", async () => {
    h.callback = async () => {
      throw new Error("connection to 10.0.0.5:5432 refused, password=hunter2");
    };
    const res = await from().get("/api/deriv/callback?code=abc&state=s1").set("Cookie", sealedCookie(null));
    expect(res.headers.location).toBe("http://localhost:5173/login?deriv_error=unknown");
    expect(JSON.stringify(res.headers)).not.toMatch(/hunter2|10\.0\.0\.5/);
  });

  it("the user declining at Deriv returns to login; Deriv's free-text error is never echoed", async () => {
    const res = await request(app)
      .get("/api/deriv/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E")
      .set("Cookie", sealedCookie(null));
    expect(res.headers.location).toBe("http://localhost:5173/login?deriv_error=access_denied");
    expect(res.headers.location).not.toMatch(/script|alert/);
  });

  it("a callback with no flow cookie at all (someone else's link, a replay) goes to login and issues nothing", async () => {
    h.callback = async () => {
      throw new ConnectError("expired");
    };
    const res = await from().get("/api/deriv/callback?code=stolen&state=whatever");
    expect(res.headers.location).toBe("http://localhost:5173/login?deriv_error=expired");
    expect(h.created).toHaveLength(0);
  });
});

describe("RECONNECT (a signed-in user refreshing Deriv) still works and never swaps the session", () => {
  it("success returns to the account page and does not issue a new session", async () => {
    h.callback = async () => ({ kind: "reconnected", userId: "user_1" });
    const res = await from().get("/api/deriv/callback?code=abc&state=s1").set("Cookie", sealedCookie("user_1"));
    expect(res.headers.location).toBe("http://localhost:5173/account?deriv=connected");
    expect(h.created).toHaveLength(0);
    expect(setCookies(res).some((c) => c.startsWith("derivdesk_session="))).toBe(false);
  });

  it("failure returns to the ACCOUNT page (the user is still signed in there)", async () => {
    h.callback = async () => {
      throw new ConnectError("account_mismatch");
    };
    const res = await from().get("/api/deriv/callback?code=abc&state=s1").set("Cookie", sealedCookie("user_1"));
    expect(res.headers.location).toBe("http://localhost:5173/account?deriv_error=account_mismatch");
  });

  it("GET /api/deriv/connect (reconnect) still requires a session", async () => {
    expect((await from().get("/api/deriv/connect")).status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("is 401 without a session", async () => {
    expect((await from().get("/api/auth/me")).status).toBe(401);
  });

  it("returns the id and handle only — no email, no password hash, nothing else", async () => {
    h.session = { id: "s", userId: "user_1", user: { id: "user_1", handle: "CR100", status: "ACTIVE", email: null, passwordHash: null } as never };
    const res = await from().get("/api/auth/me").set("Cookie", "derivdesk_session=11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { id: "user_1", handle: "CR100" } });
  });
});
