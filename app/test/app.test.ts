// End-to-end tests of the file explorer through real HTTP requests (supertest
// drives the Express app in-process; no port is opened). Everything here runs
// as a logged-in user; what happens WITHOUT a session is in auth.test.ts.

import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFixture, XSS_NAME, type Fixture } from "./fixture.js";
import { login, makeApp, type Agent } from "./helpers.js";

let fx: Fixture;
let app: Express;
let agent: Agent; // a logged-in "browser"

beforeAll(async () => {
  fx = await createFixture();
  vi.spyOn(console, "log").mockImplementation(() => {}); // silence audit lines
  app = makeApp(fx.root);
  agent = request.agent(app);
  await login(agent);
});
afterAll(() => fx.cleanup());

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /api/tree", () => {
  it("lists the root, directories first", async () => {
    const res = await agent.get("/api/tree").query({ path: "/" });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/");

    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("hello.txt");
    expect(names.indexOf("sub")).toBeLessThan(names.indexOf("hello.txt"));

    const hello = res.body.entries.find((e: { name: string }) => e.name === "hello.txt");
    expect(hello).toMatchObject({ type: "file", size: 12 });
    expect(hello.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults to the root when no path is given", async () => {
    const res = await agent.get("/api/tree");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/");
  });

  it("hides deny-listed entries from listings", async () => {
    const root = await agent.get("/api/tree").query({ path: "/" });
    expect(root.body.entries.map((e: { name: string }) => e.name)).not.toContain(".env");

    const home = await agent.get("/api/tree").query({ path: "/home/me" });
    expect(home.body.entries).toEqual([]);
  });

  it("reports symlinks as symlinks without following them", async () => {
    const res = await agent.get("/api/tree").query({ path: "/" });
    const link = res.body.entries.find((e: { name: string }) => e.name === "link-out");
    expect(link.type).toBe("symlink");
  });

  it("rejects a file", async () => {
    const res = await agent.get("/api/tree").query({ path: "/hello.txt" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/file", () => {
  it("returns a text file", async () => {
    const res = await agent.get("/api/file").query({ path: "/hello.txt" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "/hello.txt", size: 12, content: "hello world\n" });
  });

  it("requires a path", async () => {
    expect((await agent.get("/api/file")).status).toBe(400);
  });

  it("refuses files over 1 MB", async () => {
    const res = await agent.get("/api/file").query({ path: "/big.bin" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/larger/);
  });

  it("refuses binary files", async () => {
    const res = await agent.get("/api/file").query({ path: "/binary.dat" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/binary/);
  });

  it("refuses a directory", async () => {
    const res = await agent.get("/api/file").query({ path: "/sub" });
    expect(res.status).toBe(400);
  });
});

describe("traversal over HTTP", () => {
  // Raw URLs, so we control the exact encoding on the wire.
  it.each([
    ["plain", "/api/file?path=../outside/secret.txt", 403],
    ["url-encoded", "/api/file?path=%2e%2e%2foutside%2fsecret.txt", 403],
    ["deep", "/api/tree?path=../../../../../../etc", 403],
    ["via symlink", "/api/file?path=/link-out/secret.txt", 403],
    ["double-encoded", "/api/file?path=%252e%252e%252foutside%252fsecret.txt", 404],
    ["null byte", "/api/file?path=/hello.txt%00.png", 400],
    ["array param", "/api/tree?path=/&path=/sub", 400],
    ["deny-listed", "/api/file?path=/.env", 403],
  ])("%s → %i", async (_name, url, status) => {
    const res = await agent.get(url);
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).not.toContain("TOP SECRET");
  });

  it("never leaks real disk paths in error messages", async () => {
    const res = await agent.get("/api/file?path=/nope");
    expect(JSON.stringify(res.body)).not.toContain(fx.root);
  });
});

describe("HTML UI", () => {
  it("redirects / to the browser", async () => {
    const res = await agent.get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/browse?path=%2F");
  });

  it("renders a directory", async () => {
    const res = await agent.get("/browse").query({ path: "/sub" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("nested.txt");
  });

  it("renders a file", async () => {
    const res = await agent.get("/browse").query({ path: "/hello.txt" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("hello world");
  });

  it("escapes hostile file names (XSS)", async () => {
    const res = await agent.get("/browse").query({ path: "/" });
    expect(res.text).not.toContain(XSS_NAME);
    expect(res.text).toContain("&lt;img src=x onerror=alert(1)&gt;.txt");
  });

  it("renders an HTML error page for traversal", async () => {
    const res = await agent.get("/browse?path=../outside");
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("sets security headers", async () => {
    const res = await agent.get("/browse");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("read-only", () => {
  it.each(["post", "put", "patch", "delete"] as const)("%s is not routed", async (method) => {
    const res = await agent[method]("/api/file").query({ path: "/hello.txt" });
    expect(res.status).toBe(404);
  });
});
