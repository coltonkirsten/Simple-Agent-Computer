// Builds the Express app. Kept separate from server.ts (which actually
// listens on a port) so tests can create an app without opening a socket.

import path from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import type { Config } from "./config.js";
import { isDirectory, listDir, readTextFile } from "./files.js";
import { PathError, safeResolve } from "./paths.js";
import { renderDirectory, renderError, renderFile } from "./views.js";

export function createApp(config: Config): Express {
  const app = express();

  // Don't advertise the framework in an "X-Powered-By" header.
  app.disable("x-powered-by");

  // helmet sets a bundle of security headers. The important one is a strict
  // Content-Security-Policy: scripts and styles may only load from our own
  // origin. Even if an XSS bug slipped past escapeHtml(), an injected
  // <script> would refuse to run. (This is why the CSS is a separate file
  // rather than an inline <style> block.)
  app.use(helmet());

  app.use("/static", express.static(path.join(import.meta.dirname, "../public")));

  // For uptime checks and the container HEALTHCHECK. Stays unauthenticated.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res.redirect("/browse?path=%2F");
  });

  // --- HTML UI --------------------------------------------------------------
  app.get("/browse", async (req, res) => {
    const target = await safeResolve(config.fileRoot, req.query.path ?? "/");
    if (await isDirectory(target)) {
      res.send(renderDirectory(await listDir(target)));
    } else {
      res.send(renderFile(await readTextFile(target)));
    }
  });

  // --- JSON API -------------------------------------------------------------
  app.get("/api/tree", async (req, res) => {
    const target = await safeResolve(config.fileRoot, req.query.path ?? "/");
    res.json(await listDir(target));
  });

  app.get("/api/file", async (req, res) => {
    const target = await safeResolve(config.fileRoot, req.query.path);
    res.json(await readTextFile(target));
  });

  // Note what is NOT here: no POST/PUT/DELETE routes at all. Read-only.

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
    } else {
      console.error(err);
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
