// Tests for login, the allowlist, sessions, CSRF and the requireAuth gate.

import { randomBytes } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { safeReturnTo } from "../src/auth.js";
import { loadConfig, parseAllowedEmails } from "../src/config.js";
import { createFixture, type Fixture } from "./fixture.js";
import { ALLOWED, csrfTokenFrom, FakeIdentityProvider, login, makeApp } from "./helpers.js";

let fx: Fixture;
let app: Express;

beforeAll(async () => {
  fx = await createFixture();
  vi.spyOn(console, "log").mockImplementation(() => {}); // silence audit lines
});
afterAll(() => fx.cleanup());

// A fresh app per test, so the rate limiter's counter starts at zero.
beforeEach(() => {
  app = makeApp(fx.root);
});

describe("without a session", () => {
  it("redirects pages to the login flow", async () => {
    const res = await request(app).get("/browse?path=/sub");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/auth/login");
  });

  it("answers API calls with 401 JSON rather than a redirect", async () => {
    const res = await request(app).get("/api/tree?path=/");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
  });

  it("never reveals file contents", async () => {
    const res = await request(app).get("/api/file?path=/hello.txt");
    expect(res.text).not.toContain("hello world");
  });

  it("leaves /healthz and /static public", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect((await request(app).get("/static/style.css")).status).toBe(200);
  });

  it("ignores a forged session cookie", async () => {
    const res = await request(app)
      .get("/api/tree?path=/")
      .set("Cookie", "sac_session=not-a-real-sealed-session");
    expect(res.status).toBe(401);
  });

  it("ignores a cookie sealed with a different secret", async () => {
    // Log in to an app using ANOTHER secret, then replay that cookie here.
    const other = makeApp(fx.root, { sessionSecret: randomBytes(32).toString("hex") });
    const otherAgent = request.agent(other);
    const loggedIn = await login(otherAgent);
    const cookie = loggedIn.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(cookie).toBeTruthy();

    const res = await request(app).get("/api/tree?path=/").set("Cookie", cookie!);
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/login", () => {
  it("redirects to the identity provider and sets a hardened cookie", async () => {
    const res = await request(app).get("/auth/login");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://idp.test/authorize");

    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^sac_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // The login secrets are in the cookie, but sealed — not readable.
    expect(cookie).not.toContain("fake-verifier");
  });

  it("uses a Secure, __Host- prefixed cookie in production", async () => {
    const prod = makeApp(fx.root, { production: true, baseUrl: "https://files.example.com" });
    const res = await request(prod).get("/auth/login");
    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^__Host-sac_session=/);
    expect(cookie).toMatch(/Secure/i);
  });
});

describe("GET /auth/callback", () => {
  it("logs in an allowlisted user", async () => {
    const agent = request.agent(app);
    const res = await login(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");

    const page = await agent.get("/browse?path=/");
    expect(page.status).toBe(200);
    expect(page.text).toContain(ALLOWED);
    expect(page.headers["cache-control"]).toBe("no-store");
  });

  it("matches the allowlist case-insensitively", async () => {
    const agent = request.agent(app);
    expect((await login(agent, "mixedcase")).status).toBe(302);
    expect((await agent.get("/api/tree?path=/")).status).toBe(200);
  });

  it("returns the user to the page they originally asked for", async () => {
    const agent = request.agent(app);
    await agent.get("/browse?path=/sub"); // bounced to login; destination remembered
    const res = await login(agent);
    expect(res.headers.location).toBe("/browse?path=/sub");
  });

  it("rejects a user who is not on the allowlist, and creates no session", async () => {
    const agent = request.agent(app);
    const res = await login(agent, "stranger");
    expect(res.status).toBe(403);
    expect(res.text).toContain("stranger@example.com is not authorised");
    expect((await agent.get("/api/tree?path=/")).status).toBe(401);
  });

  it("rejects an allowlisted email that Google has not verified", async () => {
    const agent = request.agent(app);
    expect((await login(agent, "unverified")).status).toBe(403);
    expect((await agent.get("/api/tree?path=/")).status).toBe(401);
  });

  it("rejects a callback with the wrong state (login CSRF)", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/login");
    const res = await agent.get("/auth/callback").query({ code: "allowed", state: "forged" });
    expect(res.status).toBe(400);
    expect((await agent.get("/api/tree?path=/")).status).toBe(401);
  });

  it("rejects a callback when no login was started", async () => {
    const res = await request(app)
      .get("/auth/callback")
      .query({ code: "allowed", state: FakeIdentityProvider.STATE });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid code without leaking the reason", async () => {
    const agent = request.agent(app);
    const res = await login(agent, "garbage");
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("invalid code");
  });

  it("cannot be replayed: the pending login is single-use", async () => {
    const agent = request.agent(app);
    await login(agent, "stranger"); // consumes and destroys the pending login
    const replay = await agent
      .get("/auth/callback")
      .query({ code: "allowed", state: FakeIdentityProvider.STATE });
    expect(replay.status).toBe(400);
  });
});

describe("allowlist changes", () => {
  it("locks out a logged-in user as soon as they are removed", async () => {
    const allowed = new Set([ALLOWED]);
    const live = makeApp(fx.root, { allowedEmails: allowed });
    const agent = request.agent(live);
    await login(agent);
    expect((await agent.get("/api/tree?path=/")).status).toBe(200);

    allowed.delete(ALLOWED); // same cookie, still cryptographically valid...
    expect((await agent.get("/api/tree?path=/")).status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("logs out with a valid CSRF token", async () => {
    const agent = request.agent(app);
    await login(agent);
    const csrf = csrfTokenFrom((await agent.get("/browse?path=/")).text);

    const res = await agent.post("/auth/logout").type("form").send({ csrf });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Signed out");
    expect((await agent.get("/api/tree?path=/")).status).toBe(401);
  });

  it.each([
    ["missing", {}],
    ["wrong", { csrf: "nope" }],
  ])("refuses a %s CSRF token and keeps the session", async (_name, body) => {
    const agent = request.agent(app);
    await login(agent);
    const res = await agent.post("/auth/logout").type("form").send(body);
    expect(res.status).toBe(403);
    expect((await agent.get("/api/tree?path=/")).status).toBe(200);
  });

  it("is not reachable with GET", async () => {
    const agent = request.agent(app);
    await login(agent);
    expect((await agent.get("/auth/logout")).status).toBe(404);
    expect((await agent.get("/api/tree?path=/")).status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("throttles repeated hits on /auth", async () => {
    const statuses = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await request(app).get("/auth/login")).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 302)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("does not throttle normal browsing", async () => {
    const agent = request.agent(app);
    await login(agent);
    for (let i = 0; i < 40; i++) {
      expect((await agent.get("/api/tree?path=/")).status).toBe(200);
    }
  });
});

describe("safeReturnTo (open-redirect guard)", () => {
  it.each(["/", "/browse?path=/sub", "/api/tree"])("keeps %s", (p) =>
    expect(safeReturnTo(p)).toBe(p),
  );

  it.each([
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "evil.com",
    "/auth/callback",
    "",
    undefined,
    ["/a"],
  ])("replaces %j with /", (p) => expect(safeReturnTo(p)).toBe("/"));
});

describe("config", () => {
  const valid = {
    BASE_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    ALLOWED_EMAILS: " Me@Example.com , you@example.com,, ",
    SESSION_SECRET: "x".repeat(32),
  };

  it("normalises the allowlist", () => {
    expect([...loadConfig(valid).allowedEmails]).toEqual(["me@example.com", "you@example.com"]);
    expect(parseAllowedEmails(" , ").size).toBe(0);
  });

  it.each([
    "BASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ALLOWED_EMAILS",
    "SESSION_SECRET",
  ])("refuses to start without %s", (name) =>
    expect(() => loadConfig({ ...valid, [name]: "" })).toThrow(name),
  );

  it("refuses a short session secret", () =>
    expect(() => loadConfig({ ...valid, SESSION_SECRET: "short" })).toThrow(/32/));

  it("refuses an allowlist with no emails", () =>
    expect(() => loadConfig({ ...valid, ALLOWED_EMAILS: " , " })).toThrow(/ALLOWED_EMAILS/));

  it("requires https in production", () =>
    expect(() => loadConfig({ ...valid, NODE_ENV: "production" })).toThrow(/https/));
});
