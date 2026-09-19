// Read-only filesystem operations. There is deliberately no write, delete,
// rename or exec anywhere in this app.
//
// Functions here take a `real` path that has ALREADY been through
// safeResolve(). They never accept raw user input.

import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isDenied, PathError, type ResolvedPath } from "./paths.js";

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MB
const MAX_DIR_ENTRIES = 2000;

export type EntryType = "dir" | "file" | "symlink" | "other";

export interface Entry {
  name: string;
  type: EntryType;
  /** Bytes. null when it isn't meaningful or couldn't be read. */
  size: number | null;
  /** ISO timestamp, or null if it couldn't be read. */
  mtime: string | null;
}

export interface DirListing {
  path: string;
  entries: Entry[];
  /** True if the directory had more entries than we return. */
  truncated: boolean;
}

export async function listDir(dir: ResolvedPath): Promise<DirListing> {
  let dirents;
  try {
    dirents = await readdir(dir.real, { withFileTypes: true });
  } catch (err) {
    throw toPathError(err);
  }

  // Don't advertise entries the path guard would refuse anyway.
  const visible = dirents.filter((d) => !isDenied(path.posix.join(dir.virtual, d.name)));
  const truncated = visible.length > MAX_DIR_ENTRIES;

  const entries = await Promise.all(
    visible.slice(0, MAX_DIR_ENTRIES).map(async (d): Promise<Entry> => {
      const type: EntryType = d.isSymbolicLink()
        ? "symlink"
        : d.isDirectory()
          ? "dir"
          : d.isFile()
            ? "file"
            : "other"; // sockets, devices, pipes

      // lstat (not stat) describes the link itself and never follows it, so
      // listing a directory can't be tricked into touching anything outside.
      try {
        const info = await lstat(path.join(dir.real, d.name));
        return {
          name: d.name,
          type,
          size: type === "file" ? info.size : null,
          mtime: info.mtime.toISOString(),
        };
      } catch {
        return { name: d.name, type, size: null, mtime: null };
      }
    }),
  );

  // Directories first, then alphabetical.
  entries.sort(
    (a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name),
  );

  return { path: dir.virtual, entries, truncated };
}

export interface FileContents {
  path: string;
  size: number;
  content: string;
}

export async function readTextFile(file: ResolvedPath): Promise<FileContents> {
  let handle;
  try {
    // O_NONBLOCK: opening a named pipe normally blocks until something writes
    // to it, which would hang the request forever. With this flag the open
    // returns immediately and the isFile() check below rejects it.
    handle = await open(file.real, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    throw toPathError(err);
  }

  try {
    // stat the open handle rather than the path, so the file we measured is
    // certainly the file we read (no swap in between).
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new PathError(400, "not a regular file");
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new PathError(400, `file is larger than ${MAX_FILE_BYTES} bytes`);
    }

    // Read at most MAX_FILE_BYTES even if the file grew after the stat.
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);

    // Text files don't contain NUL bytes; binaries almost always do early on.
    if (data.subarray(0, 8192).includes(0)) {
      throw new PathError(400, "binary files are not viewable");
    }

    return { path: file.virtual, size: info.size, content: data.toString("utf8") };
  } finally {
    await handle.close();
  }
}

export async function isDirectory(target: ResolvedPath): Promise<boolean> {
  try {
    return (await stat(target.real)).isDirectory();
  } catch (err) {
    throw toPathError(err);
  }
}

function toPathError(err: unknown): unknown {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new PathError(404, "not found");
  if (code === "ENOTDIR") return new PathError(400, "not a directory");
  if (code === "EISDIR") return new PathError(400, "is a directory");
  if (code === "EACCES" || code === "EPERM") return new PathError(403, "permission denied");
  return err;
}
