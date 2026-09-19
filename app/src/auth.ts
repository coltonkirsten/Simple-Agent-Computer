// Login routes and the requireAuth gate.
//
// Two separate questions, deliberately kept apart:
//   Authentication — "who are you?"        Google answers this.
//   Authorization  — "are you allowed in?" OUR allowlist answers this.
// A valid Google login proves identity only. Anyone on earth has one.

import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { Config } from "./config.js";
import type { IdentityProvider } from "./identity.js";
import { getSession } from "./session.js";
import { renderError, renderSignedOut } from "./views.js";

/** Structured audit line. Phase 11 ships these to Cloud Logging. */
function audit(event: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function isAllowed(config: Config, email: string): boolean {
  return config.allowedEmails.has(email.toLowerCase());
}

/**
 * Only accept same-site relative paths as a post-login destination. Without
 * this check, a crafted link could use our login to bounce victims to an
 * attacker's site (an "open redirect"): "//evil.com" and "/\evil.com" are
 * both treated by browsers as absolute URLs.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value.startsWith("/auth/")) return "/";
  return value;
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Constant-time compare, so response timing can't leak the token byte by byte.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function authRouter(config: Config, provider: IdentityProvider): Router {
  const router = Router();

  // Slow down anyone hammering the login endpoints.
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: "Too many login attempts. Try again later.",
    }),
  );

  // Step 1: send the browser to Google.
  router.get("/login", async (_req, res) => {
    const session = getSession(res);
    const { redirectUrl, pending } = await provider.startLogin();
    session.pending = pending;
    await session.save();
    res.redirect(redirectUrl);
  });

  // Step 3+4: Google sent the browser back with ?code=...&state=...
  router.get("/callback", async (req, res) => {
    const session = getSession(res);
    const { pending, returnTo } = session;

    if (!pending) {
      session.destroy();
      res.status(400).send(renderError(400, "No login in progress. Please start again."));
      return;
    }

    let identity;
    try {
      const callbackUrl = new URL(req.originalUrl, config.baseUrl);
      identity = await provider.finishLogin(callbackUrl, pending);
    } catch (err) {
      // Bad state, bad nonce, reused code, user pressed "cancel", ...
      // Details go to the log; the user gets a generic message.
      audit("login_failed", { reason: err instanceof Error ? err.message : "unknown" });
      session.destroy();
      res.status(400).send(renderError(400, "Login failed. Please try again."));
      return;
    }

    // Authorization. An unverified email proves nothing about who owns the
    // address, so it's treated the same as not being on the list.
    if (!identity.emailVerified || !isAllowed(config, identity.email)) {
      audit("login_denied", { email: identity.email, emailVerified: identity.emailVerified });
      session.destroy(); // no session of any kind for a rejected user
      res
        .status(403)
        .send(renderError(403, `${identity.email} is not authorised to use this app.`));
      return;
    }

    // This login attempt is spent: its one-time secrets must not linger.
    delete session.pending;
    delete session.returnTo;
    session.user = { email: identity.email.toLowerCase(), name: identity.name };
    session.csrfToken = randomBytes(32).toString("base64url");
    await session.save();

    audit("login_allowed", { email: session.user.email });
    res.redirect(safeReturnTo(returnTo));
  });

  // Logout changes state, so it's a POST guarded by a CSRF token — otherwise
  // any web page could log you out with <img src=".../auth/logout">.
  router.post("/logout", express.urlencoded({ extended: false }), (req, res) => {
    const session = getSession(res);
    const submitted: unknown = (req.body as Record<string, unknown> | undefined)?.csrf;

    if (
      !session.csrfToken ||
      typeof submitted !== "string" ||
      !tokensMatch(submitted, session.csrfToken)
    ) {
      res.status(403).send(renderError(403, "Invalid CSRF token."));
      return;
    }

    audit("logout", { email: session.user?.email });
    session.destroy();
    res.send(renderSignedOut());
  });

  return router;
}

/** Gate for everything except /auth/*, /healthz and /static. */
export function requireAuth(config: Config) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = getSession(res);

    // Re-check the allowlist on EVERY request, not just at login. Removing
    // someone from ALLOWED_EMAILS locks them out immediately, even though
    // their 8-hour cookie is still cryptographically valid.
    if (session.user && isAllowed(config, session.user.email)) {
      // Private content: keep it out of browser and proxy caches.
      res.setHeader("Cache-Control", "no-store");
      next();
      return;
    }

    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "authentication required" });
      return;
    }

    // Remember where they were going, then start the login flow.
    session.returnTo = safeReturnTo(req.originalUrl);
    await session.save();
    res.redirect("/auth/login");
  };
}
