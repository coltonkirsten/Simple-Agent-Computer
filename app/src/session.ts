// Sessions: how the server remembers you between requests.
//
// We keep the whole session INSIDE the cookie, encrypted and signed with
// SESSION_SECRET (via iron-session). The browser holds it but can neither
// read nor modify it — tampering breaks the seal and the session is dropped.
// No database or server-side store needed, which suits one tiny VM.
//
// Trade-off to know about: a stateless session can't be revoked individually.
// Removing someone from the allowlist is still immediate, because
// requireAuth() re-checks the allowlist on every request.

import type { NextFunction, Request, Response } from "express";
import { getIronSession, type IronSession } from "iron-session";
import type { Config } from "./config.js";
import type { PendingLogin } from "./identity.js";

export interface SessionUser {
  email: string;
  name: string | null;
}

export interface SessionData {
  /** Present once logged in. */
  user?: SessionUser;
  /** Random token embedded in forms to prove a POST came from our own page. */
  csrfToken?: string;
  /** Present only between /auth/login and /auth/callback. */
  pending?: PendingLogin;
  /** Where to send the user after login. */
  returnTo?: string;
}

export type Session = IronSession<SessionData>;

const EIGHT_HOURS = 8 * 60 * 60;

export function sessionMiddleware(config: Config) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.locals.session = await getIronSession<SessionData>(req, res, {
      password: config.sessionSecret,
      // The "__Host-" prefix makes browsers enforce: Secure, Path=/, and no
      // Domain attribute — so no other subdomain can plant or overwrite it.
      // It requires HTTPS, so plain-http local dev uses the unprefixed name.
      cookieName: config.production ? "__Host-sac_session" : "sac_session",
      // Expiry is sealed INSIDE the encrypted data too, so an old cookie
      // can't be replayed after 8h even if the browser kept it.
      ttl: EIGHT_HOURS,
      cookieOptions: {
        httpOnly: true, // invisible to JavaScript → can't be stolen via XSS
        secure: config.production, // HTTPS only (off for http://localhost)
        // Lax: sent when the user navigates to us (needed for the redirect
        // back from Google) but not on cross-site POSTs or embedded requests.
        sameSite: "lax",
        path: "/",
      },
    });
    next();
  };
}

export function getSession(res: Response): Session {
  return res.locals.session as Session;
}
