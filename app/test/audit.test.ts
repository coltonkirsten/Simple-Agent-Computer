// The audit trail is a security feature, so it gets tests like one: the right
// events, the right fields, and nothing sensitive.

import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixture, type Fixture } from "./fixture.js";
import { ALLOWED, csrfTokenFrom, login, makeApp } from "./helpers.js";

let fx: Fixture;
let app: Express;
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

/** Every audit line logged so far, parsed. */
function auditLines(): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry?.audit === true);
}

const eventsNamed = (name: string) => auditLines().filter((entry) => entry.event === name);

beforeAll(async () => {
  fx = await createFixture();
});
afterAll(() => fx.cleanup());
beforeEach(() => {
  app = makeApp(fx.root);
  logSpy.mockClear();
});

describe("audit trail", () => {
  it("records an allowed login with who and when", async () => {
    await login(request.agent(app));
    const [entry] = eventsNamed("login_allowed");
    expect(entry).toMatchObject({ severity: "INFO", email: ALLOWED, message: "login_allowed" });
    expect(entry?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry?.ip).toBeTruthy();
  });

  it("records a denied login as a WARNING", async () => {
    await login(request.agent(app), "stranger");
    expect(eventsNamed("login_denied")[0]).toMatchObject({
      severity: "WARNING",
      email: "stranger@example.com",
    });
  });

  it("records a failed login without leaking details to the user", async () => {
    const res = await login(request.agent(app), "garbage");
    expect(eventsNamed("login_failed")[0]).toMatchObject({ reason: "invalid code" });
    expect(res.text).not.toContain("invalid code");
  });

  it("records directory listings and file views, with the canonical path", async () => {
    const agent = request.agent(app);
    await login(agent);
    await agent.get("/browse").query({ path: "/sub" });
    await agent.get("/api/file").query({ path: "/sub/../hello.txt" });

    expect(eventsNamed("dir_list")[0]).toMatchObject({ email: ALLOWED, path: "/sub" });
    // Logged as the RESOLVED path, not the raw input.
    expect(eventsNamed("file_view")[0]).toMatchObject({
      email: ALLOWED,
      path: "/hello.txt",
      bytes: 12,
    });
  });

  it("records a logged-in user probing outside the root", async () => {
    const agent = request.agent(app);
    await login(agent);
    await agent.get("/api/file?path=../outside/secret.txt");
    await agent.get("/api/file?path=/.env");

    const denied = eventsNamed("access_denied");
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({
      severity: "WARNING",
      email: ALLOWED,
      requested: "../outside/secret.txt",
    });
  });

  it("does not record plain 404s", async () => {
    const agent = request.agent(app);
    await login(agent);
    await agent.get("/api/file?path=/nope.txt");
    expect(eventsNamed("access_denied")).toHaveLength(0);
  });

  it("records logout", async () => {
    const agent = request.agent(app);
    await login(agent);
    const csrf = csrfTokenFrom((await agent.get("/browse?path=/")).text);
    await agent.post("/auth/logout").type("form").send({ csrf });
    expect(eventsNamed("logout")[0]).toMatchObject({ email: ALLOWED });
  });

  it("never logs file contents, cookies or tokens", async () => {
    const agent = request.agent(app);
    const loggedIn = await login(agent);
    const page = await agent.get("/browse?path=/");
    await agent.get("/api/file").query({ path: "/hello.txt" });

    const everything = logSpy.mock.calls.flat().join("\n");
    const cookieValue = String(loggedIn.headers["set-cookie"]?.[0]).split(";")[0]?.split("=")[1];
    expect(everything).not.toContain("hello world");
    expect(everything).not.toContain(cookieValue);
    expect(everything).not.toContain(csrfTokenFrom(page.text));
  });

  it("cannot be forged through a hostile path (log injection)", async () => {
    const agent = request.agent(app);
    await login(agent);
    const hostile = '../x\n{"audit":true,"event":"login_allowed","email":"attacker@evil.com"}';
    await agent.get("/api/file").query({ path: hostile });

    // The newline is escaped inside one JSON string, so no second line exists.
    expect(eventsNamed("login_allowed").map((entry) => entry.email)).toEqual([ALLOWED]);
    expect(eventsNamed("access_denied")[0]?.requested).toBe(hostile);
  });
});

describe("favicon", () => {
  it("is answered publicly and doesn't hijack the post-login destination", async () => {
    const agent = request.agent(app);
    await agent.get("/browse?path=/sub"); // remembered as the destination
    expect((await agent.get("/favicon.ico")).status).toBe(204);
    const res = await login(agent);
    expect(res.headers.location).toBe("/browse?path=/sub");
  });
});
