// All configuration comes from environment variables, read once at startup.
// Fail fast: a missing or weak setting stops the server from starting rather
// than surfacing later as a confusing (or insecure) runtime behaviour.

import path from "node:path";

export interface Config {
  /** Directory exposed by the explorer. On the VM this will be /host. */
  fileRoot: string;
  host: string;
  port: number;
  /** True when NODE_ENV=production: Secure cookies, trust the reverse proxy. */
  production: boolean;
  /** Public origin of the app, e.g. https://files.example.com (no trailing slash). */
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Lowercased emails allowed to log in. */
  allowedEmails: ReadonlySet<string>;
  sessionSecret: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export function parseAllowedEmails(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const production = env.NODE_ENV === "production";

  const baseUrl = new URL(required(env, "BASE_URL"));
  if (production && baseUrl.protocol !== "https:") {
    throw new Error("BASE_URL must be https in production");
  }

  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)");
  }

  // An empty allowlist would lock everyone out; that's certainly a mistake.
  const allowedEmails = parseAllowedEmails(required(env, "ALLOWED_EMAILS"));
  if (allowedEmails.size === 0) {
    throw new Error("ALLOWED_EMAILS contains no emails");
  }

  return {
    fileRoot: path.resolve(env.FILE_ROOT ?? "."),
    host: env.HOST ?? "127.0.0.1",
    port,
    production,
    baseUrl: baseUrl.origin,
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    allowedEmails,
    sessionSecret,
  };
}
