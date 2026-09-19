// Server-rendered HTML. No template engine and no client-side JavaScript —
// just functions returning strings.
//
// File and directory names are attacker-controllable data (anyone who can
// create a file on the VM picks its name), so EVERY dynamic value goes
// through escapeHtml() before it touches the page. That is what prevents
// XSS from a file called `<script>alert(1)</script>`.

import type { DirListing, FileContents } from "./files.js";

/** The logged-in user, for the header. Absent on error and signed-out pages. */
export interface Viewer {
  email: string;
  csrfToken: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function browseUrl(virtualPath: string): string {
  return `/browse?path=${encodeURIComponent(virtualPath)}`;
}

function joinVirtual(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function header(viewer: Viewer | undefined): string {
  if (!viewer) return "";
  // Logout is a POST form (not a link) carrying the CSRF token; see auth.ts.
  return `  <header>
    <span>${escapeHtml(viewer.email)}</span>
    <form method="post" action="/auth/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}">
      <button type="submit">Log out</button>
    </form>
  </header>`;
}

function layout(title: string, body: string, viewer?: Viewer): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
${header(viewer)}
  <main>
${body}
  </main>
</body>
</html>`;
}

/** "/etc/ssh" → root / etc / ssh, each segment a link to that directory. */
function breadcrumb(virtualPath: string): string {
  const segments = virtualPath.split("/").filter(Boolean);
  const links = [`<a href="${browseUrl("/")}">root</a>`];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    links.push(`<a href="${browseUrl(current)}">${escapeHtml(segment)}</a>`);
  }
  return `<nav class="breadcrumb">${links.join('<span class="sep">/</span>')}</nav>`;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const ICONS = { dir: "📁", file: "📄", symlink: "🔗", other: "⚙️" } as const;

export function renderDirectory(listing: DirListing, viewer: Viewer): string {
  const rows = listing.entries
    .map((entry) => {
      const name = escapeHtml(entry.name);
      // Sockets, devices and pipes aren't browsable, so they aren't links.
      const label =
        entry.type === "other"
          ? name
          : `<a href="${browseUrl(joinVirtual(listing.path, entry.name))}">${name}</a>`;
      const mtime = entry.mtime ? entry.mtime.slice(0, 16).replace("T", " ") : "";
      return `      <tr>
        <td class="icon">${ICONS[entry.type]}</td>
        <td class="name">${label}</td>
        <td class="size">${formatSize(entry.size)}</td>
        <td class="mtime">${mtime}</td>
      </tr>`;
    })
    .join("\n");

  const empty = listing.entries.length === 0 ? `<p class="note">Empty directory.</p>` : "";
  const truncated = listing.truncated
    ? `<p class="note">Large directory — only the first entries are shown.</p>`
    : "";

  return layout(
    listing.path,
    `${breadcrumb(listing.path)}
    <table>
      <thead><tr><th></th><th>Name</th><th>Size</th><th>Modified (UTC)</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    ${empty}${truncated}`,
    viewer,
  );
}

export function renderFile(file: FileContents, viewer: Viewer): string {
  return layout(
    file.path,
    `${breadcrumb(file.path)}
    <p class="note">${formatSize(file.size)}</p>
    <pre>${escapeHtml(file.content)}</pre>`,
    viewer,
  );
}

export function renderError(status: number, message: string): string {
  return layout(
    `${status}`,
    `<h1>${status}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="${browseUrl("/")}">Back to root</a></p>`,
  );
}

export function renderSignedOut(): string {
  return layout(
    "Signed out",
    `<h1>Signed out</h1>
    <p><a href="/auth/login">Sign in again</a></p>`,
  );
}
