// Shared test setup: a config, a fake identity provider, and a login helper.

import { randomBytes } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { Identity, IdentityProvider, PendingLogin } from "../src/identity.js";

export const ALLOWED = "allowed@example.com";

// Generated per test run rather than hard-coded: nothing secret-shaped ever
// lands in git (and the gitleaks pre-commit hook stays happy).
const TEST_SESSION_SECRET = randomBytes(32).toString("hex");

export function testConfig(fileRoot: string, overrides: Partial<Config> = {}): Config {
  return {
    fileRoot,
    host: "127.0.0.1",
    port: 0,
    production: false,
    baseUrl: "http://localhost:3000",
    googleClientId: "test-client-id",
    googleClientSecret: "test-client-secret",
    allowedEmails: new Set([ALLOWED]),
    sessionSecret: TEST_SESSION_SECRET,
    version: "test-version",
    ...overrides,
  };
}

/**
 * Stands in for Google. The `code` query parameter on the callback chooses
 * who "logged in", so each test can pick its scenario:
 *   ?code=allowed | stranger | unverified | mixedcase    (anything else fails)
 * Like the real library, it rejects a callback whose state doesn't match.
 */
export class FakeIdentityProvider implements IdentityProvider {
  static readonly STATE = "fake-state";

  private static readonly PEOPLE: Record<string, Identity> = {
    allowed: { email: ALLOWED, emailVerified: true, name: "Allowed User" },
    mixedcase: { email: "Allowed@Example.COM", emailVerified: true, name: null },
    stranger: { email: "stranger@example.com", emailVerified: true, name: null },
    // On the allowlist, but Google hasn't verified they own the address.
    unverified: { email: ALLOWED, emailVerified: false, name: null },
  };

  async startLogin() {
    const pending: PendingLogin = {
      state: FakeIdentityProvider.STATE,
      nonce: "fake-nonce",
      codeVerifier: "fake-verifier",
    };
    return { redirectUrl: `https://idp.test/authorize?state=${pending.state}`, pending };
  }

  async finishLogin(callbackUrl: URL, pending: PendingLogin): Promise<Identity> {
    if (callbackUrl.searchParams.get("state") !== pending.state) {
      throw new Error("state mismatch");
    }
    const person = FakeIdentityProvider.PEOPLE[callbackUrl.searchParams.get("code") ?? ""];
    if (!person) throw new Error("invalid code");
    return person;
  }
}

export function makeApp(fileRoot: string, overrides: Partial<Config> = {}): Express {
  return createApp(testConfig(fileRoot, overrides), new FakeIdentityProvider());
}

export type Agent = ReturnType<typeof request.agent>;

/**
 * supertest talks to the app on 127.0.0.1:<random port>. The login route
 * insists on the canonical host, so tests present the Host header a real
 * browser would send when visiting BASE_URL.
 */
export const CANONICAL_HOST = "localhost:3000";

/** Run the full login flow. The agent keeps cookies between requests, like a browser. */
export async function login(agent: Agent, code = "allowed") {
  await agent.get("/auth/login").set("Host", CANONICAL_HOST);
  return agent.get("/auth/callback").query({ code, state: FakeIdentityProvider.STATE });
}

/** Pull the CSRF token out of a rendered page, as a browser submitting the form would. */
export function csrfTokenFrom(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}
