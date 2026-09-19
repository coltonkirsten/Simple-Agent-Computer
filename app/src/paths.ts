// The path guard. EVERY filesystem access in this app goes through
// safeResolve() — it is the one place that decides what a user may touch.
//
// Vocabulary:
//   root          the real directory on disk we expose (FILE_ROOT), e.g. /host
//   virtual path  what the user sees and sends, always rooted at "/".
//                 Virtual "/etc/hosts" means "<root>/etc/hosts" on disk.

import { realpath } from "node:fs/promises";
import path from "node:path";

/** An error that is safe to show to the user, with an HTTP status. */
export class PathError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "PathError";
  }
}

// Virtual paths that are never served, even though they are inside the root.
// When the root is a whole machine's filesystem these hold secrets or are
// kernel interfaces that can hang or leak when read.
const DENIED_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/run/secrets",
  "/run/sac", // this app's own runtime secrets on the VM (infra/start-app.sh)
  "/var/lib/docker",
  "/var/lib/caddy", // TLS private keys (Phase 8)
  "/etc/shadow",
  "/etc/shadow-",
  "/etc/gshadow",
  "/etc/gshadow-",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/ssh",
  "/root/.ssh",
];

// Denied wherever they appear, e.g. /home/anyone/.ssh/id_ed25519
const DENIED_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".config/gcloud"]);

export function isDenied(virtualPath: string): boolean {
  const byPrefix = DENIED_PREFIXES.some(
    (prefix) => virtualPath === prefix || virtualPath.startsWith(prefix + "/"),
  );
  if (byPrefix) return true;

  const segments = virtualPath.split("/");
  return segments.some(
    (segment, i) =>
      DENIED_SEGMENTS.has(segment) ||
      // .env, .env.local, .env.production ...
      segment === ".env" ||
      segment.startsWith(".env.") ||
      // two-segment entries like ".config/gcloud"
      DENIED_SEGMENTS.has(`${segment}/${segments[i + 1] ?? ""}`),
  );
}

/** True if `child` is `parent` or somewhere beneath it. Both must be absolute. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  // Escaping means the first SEGMENT is "..". A plain startsWith("..") would
  // also reject an innocent file that is merely named "..notes".
  const escapes = relative === ".." || relative.startsWith(".." + path.sep);
  return !escapes && !path.isAbsolute(relative);
}

export interface ResolvedPath {
  /** Real, symlink-free absolute path on disk. Safe to hand to fs functions. */
  real: string;
  /** Canonical virtual path, e.g. "/etc/hosts". Safe to show to the user. */
  virtual: string;
}

/**
 * Turn untrusted user input into a real path that is guaranteed to be inside
 * `root`, or throw a PathError.
 *
 * Two checks, and both matter:
 *   1. Lexical  — after normalising "..", is the path still under root?
 *                 Stops plain traversal like "../../etc/passwd".
 *   2. Physical — after the OS resolves every symlink, is it STILL under root?
 *                 Stops a symlink inside root that points outside it. A
 *                 lexical check alone can't see this.
 */
export async function safeResolve(root: string, userPath: unknown): Promise<ResolvedPath> {
  // Express parses ?path=a&path=b as an array and ?path[x]=1 as an object.
  if (typeof userPath !== "string") {
    throw new PathError(400, "path must be a single string");
  }
  // A NUL byte can truncate paths in lower-level APIs. Never legitimate.
  if (userPath.includes("\0")) {
    throw new PathError(400, "path contains a null byte");
  }
  if (userPath.length > 4096) {
    throw new PathError(400, "path is too long");
  }

  const realRoot = await realpath(root);

  // Prefixing "./" makes an absolute-looking input ("/etc") resolve relative
  // to the root instead of replacing it: resolve("/host", ".//etc") → /host/etc
  const candidate = path.resolve(realRoot, "./" + userPath);

  // Check 1: lexical.
  if (!isInside(realRoot, candidate)) {
    throw new PathError(403, "path escapes the root");
  }

  // Check 2: physical. realpath() follows every symlink along the way.
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new PathError(404, "not found");
    if (code === "EACCES" || code === "EPERM") throw new PathError(403, "permission denied");
    if (code === "ELOOP") throw new PathError(400, "too many symlinks");
    throw err;
  }
  if (!isInside(realRoot, real)) {
    throw new PathError(403, "path escapes the root");
  }

  // Deny-list is checked on the RESOLVED path, so a symlink can't be used to
  // reach a denied location under another name.
  const virtual = "/" + path.relative(realRoot, real).split(path.sep).join("/");
  if (isDenied(virtual)) {
    throw new PathError(403, "this path is not viewable");
  }

  return { real, virtual };
}
