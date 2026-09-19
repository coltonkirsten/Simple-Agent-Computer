# app/

Read-only file explorer. Node 22 + TypeScript + Express, server-rendered HTML,
no client-side JavaScript.

> ⚠️ There is **no login yet** (that's Phase 6), so the server binds to
> `127.0.0.1` only. Don't set `HOST=0.0.0.0` until auth exists.

## Run it

```sh
npm install
npm test
npm run dev                      # http://localhost:3000, serves this directory
FILE_ROOT=$HOME npm run dev      # ...or any directory you like
```

| Env var | Default | Meaning |
|---|---|---|
| `FILE_ROOT` | `.` | Directory to expose. On the VM this will be `/host`. |
| `HOST` | `127.0.0.1` | Interface to bind |
| `PORT` | `3000` | |

## Source map

| File | What it does |
|---|---|
| `src/paths.ts` | **The security core.** `safeResolve()` turns untrusted input into a path guaranteed to be inside the root; deny-list for sensitive locations |
| `src/files.ts` | Read-only fs operations: list a directory, read a text file (≤ 1 MB, no binaries) |
| `src/views.ts` | HTML rendering. Everything dynamic passes through `escapeHtml()` |
| `src/app.ts` | Express wiring: security headers, routes, error handling |
| `src/config.ts` | Environment variables → config |
| `src/server.ts` | Entry point; listens and handles SIGTERM |
| `test/` | `paths.test.ts` attacks the path guard directly; `app.test.ts` attacks it over HTTP |

## Routes

| Route | Returns |
|---|---|
| `GET /browse?path=` | HTML — directory listing or file viewer |
| `GET /api/tree?path=` | JSON directory listing |
| `GET /api/file?path=` | JSON file contents |
| `GET /healthz` | `{"status":"ok"}` |

There are no POST/PUT/DELETE routes. The app cannot modify anything.

## Try to break it

```sh
curl -i 'localhost:3000/api/tree?path=../../'
curl -i 'localhost:3000/api/file?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd'
ln -s /etc escape && curl -i 'localhost:3000/api/tree?path=/escape'; rm escape
```

All three should be `403`.

## Scripts

`npm run dev` · `build` · `start` · `test` · `typecheck` · `lint` · `format`
