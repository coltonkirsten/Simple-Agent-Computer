// Tests for the path guard — the most security-critical code in the app.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDenied, PathError, safeResolve } from "../src/paths.js";
import { createFixture, type Fixture } from "./fixture.js";

let fx: Fixture;
let realRoot: string;

beforeAll(async () => {
  fx = await createFixture();
  realRoot = await realpath(fx.root); // on macOS /tmp is itself a symlink
});
afterAll(() => fx.cleanup());

async function expectRejected(userPath: unknown, status: number) {
  const err = await safeResolve(fx.root, userPath).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PathError);
  expect((err as PathError).status).toBe(status);
}

describe("safeResolve: allowed paths", () => {
  it.each(["/", "", ".", "./"])("resolves %j to the root", async (input) => {
    expect(await safeResolve(fx.root, input)).toEqual({ real: realRoot, virtual: "/" });
  });

  it("resolves a nested file", async () => {
    const resolved = await safeResolve(fx.root, "/sub/nested.txt");
    expect(resolved.real).toBe(path.join(realRoot, "sub/nested.txt"));
    expect(resolved.virtual).toBe("/sub/nested.txt");
  });

  it("treats absolute-looking input as relative to the root, not the real /", async () => {
    // "/hello.txt" must mean <root>/hello.txt — never the machine's /hello.txt
    const resolved = await safeResolve(fx.root, "/hello.txt");
    expect(resolved.real).toBe(path.join(realRoot, "hello.txt"));
  });

  it("allows '..' that stays inside the root", async () => {
    expect((await safeResolve(fx.root, "/sub/../hello.txt")).virtual).toBe("/hello.txt");
  });

  it("follows a symlink that stays inside the root, reporting the real location", async () => {
    expect((await safeResolve(fx.root, "/link-in/nested.txt")).virtual).toBe("/sub/nested.txt");
  });
});

describe("safeResolve: traversal", () => {
  it.each([
    "..",
    "../",
    "../outside/secret.txt",
    "../../../../../../etc/passwd",
    "/../outside/secret.txt",
    "sub/../../outside/secret.txt",
    "/sub/../../outside/secret.txt",
    "./././../outside",
  ])("blocks %j", (input) => expectRejected(input, 403));

  it("does not decode percent-encoding itself (no double-decode hole)", async () => {
    // Express decodes the query string exactly once. If "%2e%2e" still
    // reaches us, it's a literal (non-existent) file name — not "..".
    await expectRejected("%2e%2e/outside/secret.txt", 404);
    await expectRejected("..%2foutside", 404);
  });
});

describe("safeResolve: symlinks", () => {
  it("blocks a symlink pointing outside the root", () => expectRejected("/link-out", 403));

  it("blocks reading through a symlink pointing outside the root", () =>
    expectRejected("/link-out/secret.txt", 403));

  it("blocks a symlink pointing at a denied path", () => expectRejected("/link-ssh", 403));
});

describe("safeResolve: bad input", () => {
  it("rejects a null byte", () => expectRejected("/hello.txt\0.png", 400));
  it("rejects an array (?path=a&path=b)", () => expectRejected(["/", "/sub"], 400));
  it("rejects an object (?path[x]=1)", () => expectRejected({ x: "1" }, 400));
  it("rejects undefined", () => expectRejected(undefined, 400));
  it("rejects an over-long path", () => expectRejected("a/".repeat(3000), 400));
  it("returns 404 for a missing path", () => expectRejected("/nope.txt", 404));
  it("returns 404 when a file is used as a directory", () => expectRejected("/hello.txt/x", 404));
});

describe("deny-list", () => {
  it.each([
    "/proc",
    "/proc/1/environ",
    "/sys/kernel",
    "/dev/mem",
    "/etc/shadow",
    "/etc/ssh/ssh_host_ed25519_key",
    "/var/lib/docker/containers",
    "/root/.ssh/authorized_keys",
    "/home/me/.ssh",
    "/home/me/.ssh/id_ed25519",
    "/home/me/.config/gcloud/credentials.db",
    "/srv/app/.env",
    "/srv/app/.env.production",
  ])("denies %s", (p) => expect(isDenied(p)).toBe(true));

  it.each([
    "/",
    "/etc",
    "/etc/hosts",
    "/etc/shadowfax", // shares a prefix with /etc/shadow but is a different name
    "/procedures",
    "/home/me/.config/other",
    "/srv/app/.envrc",
  ])("allows %s", (p) => expect(isDenied(p)).toBe(false));

  it("is enforced by safeResolve", async () => {
    await expectRejected("/.env", 403);
    await expectRejected("/home/me/.ssh/id_ed25519", 403);
  });
});
