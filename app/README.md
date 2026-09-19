# app/

Read-only file explorer behind Google login. Node 22 + TypeScript + Express,
server-rendered HTML, no client-side JavaScript.

## Run it

```sh
npm install
npm test                         # uses a fake identity provider: no Google, no .env needed
cp .env.example .env             # then fill it in (see the comments in that file)
npm run dev                      # http://localhost:3000, serves this directory
FILE_ROOT=$HOME npm run dev      # ...or any directory you like
```

`npm run dev` loads `.env` automatically (Node's `--env-file`). The server
refuses to start if a required variable is missing or weak.

| Env var                                    | Default     | Meaning                                                                             |
| ------------------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | required    | OAuth client from Google Auth Platform                                              |
| `BASE_URL`                                 | required    | Public origin. Callback is `${BASE_URL}/auth/callback`. Must be https in production |
| `ALLOWED_EMAILS`                           | required    | Comma-separated allowlist                                                           |
| `SESSION_SECRET`                           | required    | At least 32 chars; encrypts the session cookie                                      |
| `FILE_ROOT`                                | `.`         | Directory to expose. On the VM this will be `/host`                                 |
| `HOST`                                     | `127.0.0.1` | Interface to bind                                                                   |
| `PORT`                                     | `3000`      |                                                                                     |
| `NODE_ENV`                                 |             | `production` turns on the Secure `__Host-` cookie and trusts one proxy hop          |

## How login works

```
browser -- GET /browse ---------------> app     no session: remember destination
        <- 302 /auth/login ------------
        -- GET /auth/login -----------> app     create state + nonce + PKCE verifier,
        <- 302 accounts.google.com ----         seal them in the session cookie
        -- log in at Google ----------> Google  (we never see the password)
        <- 302 /auth/callback?code&state
        -- GET /auth/callback --------> app --> Google: swap code + verifier +
                                                client secret for a signed ID token
                                        app     verify signature / state / nonce, then:
                                                email_verified? on the allowlist?
        <- 302 back to /browse --------         yes: session    no: 403, no session
```

## Source map

| File              | What it does                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/paths.ts`    | **The security core.** `safeResolve()` turns untrusted input into a path guaranteed to be inside the root; deny-list for sensitive locations |
| `src/files.ts`    | Read-only fs operations: list a directory, read a text file (max 1 MB, no binaries)                                                          |
| `src/identity.ts` | The OIDC flow against Google (via `openid-client`), behind an `IdentityProvider` interface so tests can fake it                              |
| `src/session.ts`  | Encrypted, stateless cookie sessions (`iron-session`) and the cookie flags                                                                   |
| `src/auth.ts`     | `/auth/login`, `/auth/callback`, `/auth/logout`, the allowlist check, and the `requireAuth` gate                                             |
| `src/views.ts`    | HTML rendering. Everything dynamic passes through `escapeHtml()`                                                                             |
| `src/app.ts`      | Express wiring: security headers, routes, error handling. **Route order decides what is public**                                             |
| `src/config.ts`   | Environment variables to validated config                                                                                                    |
| `src/server.ts`   | Entry point; listens and handles SIGTERM                                                                                                     |
| `test/`           | `paths.test.ts` attacks the path guard directly, `app.test.ts` attacks it over HTTP, `auth.test.ts` attacks login, sessions and CSRF         |

## Routes

| Route                                                        | Returns                                |
| ------------------------------------------------------------ | -------------------------------------- |
| `GET /browse?path=`                                          | HTML: directory listing or file viewer |
| `GET /api/tree?path=`                                        | JSON directory listing                 |
| `GET /api/file?path=`                                        | JSON file contents                     |
| `GET /healthz`                                               | `{"status":"ok"}` (public)             |
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Login flow (public, rate-limited)      |

Everything except `/healthz`, `/static` and `/auth/*` requires a session.
There are no POST/PUT/DELETE file routes. The app cannot modify anything.

## Try to break it

Without a session everything is `401`:

```sh
curl -i 'localhost:3000/api/tree?path=/'
curl -i 'localhost:3000/api/tree?path=/' -H 'Cookie: sac_session=forged'
```

To attack the path guard you now need a real session. Log in with a browser,
copy the `sac_session` cookie value from DevTools (Application → Cookies), then:

```sh
C='Cookie: sac_session=<paste>'
curl -i -H "$C" 'localhost:3000/api/tree?path=../../'
curl -i -H "$C" 'localhost:3000/api/file?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd'
```

Both should be `403`.

## Scripts

`npm run dev` · `build` · `start` · `test` · `typecheck` · `lint` · `format`
