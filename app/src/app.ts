// Builds the Express app. Kept separate from server.ts (which actually
// listens on a port) so tests can create an app without opening a socket.

import path from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import { authRouter, requireAuth } from "./auth.js";
import type { Config } from "./config.js";
import { isDirectory, listDir, readTextFile } from "./files.js";
import type { IdentityProvider } from "./identity.js";
import { audit, logError } from "./log.js";
import { PathError, safeResolve } from "./paths.js";
import { getSession, sessionMiddleware, type Session } from "./session.js";
import { renderDirectory, renderError, renderFile, type Viewer } from "./views.js";

export function createApp(config: Config, identityProvider: IdentityProvider): Express {
  const app = express();

  // In production we sit behind one reverse proxy (Caddy, Phase 8). Trusting
  // exactly one hop makes req.ip the real client address (for rate limiting)
  // instead of the proxy's. Never enable this without a proxy in front:
  // clients could then spoof their IP with an X-Forwarded-For header.
  if (config.production) {
    app.set("trust proxy", 1);
  }

  // Don't advertise the framework in an "X-Powered-By" header.
  app.disable("x-powered-by");

  // helmet sets a bundle of security headers. The important one is a strict
  // Content-Security-Policy: scripts and styles may only load from our own
  // origin. Even if an XSS bug slipped past escapeHtml(), an injected
  // <script> would refuse to run. (This is why the CSS is a separate file
  // rather than an inline <style> block.)
  app.use(
    helmet({
      contentSecurityPolicy: {
        // Start from "nothing is allowed" and open only what the pages use:
        // one stylesheet, and forms that post back to us. No scripts at all —
        // this app ships zero JavaScript, so there is nothing to allow.
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "style-src": ["'self'"],
          "img-src": ["'self'"],
          "form-action": ["'self'"],
          "base-uri": ["'none'"], // no <base> tag hijacking relative links
          "frame-ancestors": ["'none'"], // nobody may embed us in an iframe (clickjacking)
        },
      },
    }),
  );

  app.use("/static", express.static(path.join(import.meta.dirname, "../public")));

  // For uptime checks and the container HEALTHCHECK. Stays unauthenticated.
  // Reports the running version so a deploy can confirm the NEW code is live,
  // not merely that something answered. (The commit SHA isn't sensitive: the
  // repo is public.)
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: config.version });
  });

  // Browsers request this on their own. Answer it here, publicly: if it fell
  // through to requireAuth it would overwrite the "return to" destination and
  // send people to /favicon.ico after logging in.
  app.get("/favicon.ico", (_req, res) => {
    res.status(204).end();
  });

  // ORDER MATTERS. Everything registered ABOVE requireAuth is public;
  // everything BELOW it needs a logged-in, allowlisted user. Putting the gate
  // in one place means a new route is protected by default.
  app.use(sessionMiddleware(config));
  app.use("/auth", authRouter(config, identityProvider));
  app.use(requireAuth(config));

  app.get("/", (_req, res) => {
    res.redirect("/browse?path=%2F");
  });

  // requireAuth guarantees both fields exist by the time this is called.
  const viewerOf = (res: express.Response): Viewer => {
    const session = getSession(res);
    return { email: session.user!.email, csrfToken: session.csrfToken! };
  };

  // --- HTML UI --------------------------------------------------------------
  app.get("/browse", async (req, res) => {
    const target = await safeResolve(config.fileRoot, req.query.path ?? "/");
    const email = viewerOf(res).email;
    if (await isDirectory(target)) {
      const listing = await listDir(target);
      audit("dir_list", { email, path: target.virtual });
      res.send(renderDirectory(listing, viewerOf(res)));
    } else {
      const file = await readTextFile(target);
      audit("file_view", { email, path: target.virtual, bytes: file.size });
      res.send(renderFile(file, viewerOf(res)));
    }
  });

  // --- JSON API -------------------------------------------------------------
  app.get("/api/tree", async (req, res) => {
    const target = await safeResolve(config.fileRoot, req.query.path ?? "/");
    const listing = await listDir(target);
    audit("dir_list", { email: viewerOf(res).email, path: target.virtual });
    res.json(listing);
  });

  app.get("/api/file", async (req, res) => {
    const target = await safeResolve(config.fileRoot, req.query.path);
    const file = await readTextFile(target);
    audit("file_view", { email: viewerOf(res).email, path: target.virtual, bytes: file.size });
    res.json(file);
  });

  // Note what is NOT here: no POST/PUT/DELETE file routes at all. Read-only.

  app.use((_req, res) => {
    res.status(404).send(renderError(404, "Not found"));
  });

  // Express 5 forwards errors thrown in async handlers to this middleware.
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    let status = 500;
    // Only PathError messages are written for users. Anything else might
    // contain real disk paths or stack details, so it gets a generic message
    // and the detail goes to the server log only.
    let message = "Internal server error";
    if (err instanceof PathError) {
      status = err.status;
      message = err.message;
      // A logged-in user probing outside the root or at deny-listed paths is
      // exactly what an audit trail is for. (404s are just typos; skip them.)
      if (status === 403) {
        audit("access_denied", {
          // Optional chaining: an error thrown before the session middleware
          // ran must not crash the error handler itself.
          email: (res.locals.session as Session | undefined)?.user?.email,
          requested: typeof req.query.path === "string" ? req.query.path.slice(0, 500) : undefined,
          reason: err.message,
        });
      }
    } else {
      logError("unhandled_error", err);
    }

    if (req.path.startsWith("/api/")) {
      res.status(status).json({ error: message });
    } else {
      res.status(status).send(renderError(status, message));
    }
  };
  app.use(errorHandler);

  return app;
}
