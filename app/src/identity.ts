// "Sign in with Google" = OpenID Connect (OIDC), an identity layer on OAuth 2.0.
//
// The authorization-code flow, in four steps:
//   1. We redirect the browser to Google with a request describing our app.
//   2. The user logs in AT GOOGLE. We never see their password.
//   3. Google redirects the browser back to /auth/callback with a one-time `code`.
//   4. Our SERVER swaps that code (+ our client secret) for an ID token: a
//      JWT signed by Google saying "this is alice@gmail.com".
//
// Three random values protect the flow. All are created in startLogin(), kept
// in the user's encrypted session cookie, and checked in finishLogin():
//   state  ties the callback to the browser that started the login. Without
//          it, an attacker could trick your browser into completing THEIR
//          login (login CSRF).
//   nonce  is baked into the ID token by Google. Proves the token was minted
//          for this login attempt and isn't an old one being replayed.
//   PKCE   we send a hash (challenge) up front and reveal the original
//          (verifier) when redeeming the code. A stolen code is useless
//          without the verifier.
//
// We use a certified library (openid-client) rather than hand-rolling this:
// it verifies the token signature, issuer, audience, expiry, state and nonce.

import * as oidc from "openid-client";

/** Secrets for one in-flight login attempt. Lives in the session cookie. */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface Identity {
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * The seam between our app and the identity provider. The app only depends on
 * this interface, so tests can substitute a fake and never talk to Google.
 */
export interface IdentityProvider {
  startLogin(): Promise<{ redirectUrl: string; pending: PendingLogin }>;
  /** Throws if the callback is invalid in any way. */
  finishLogin(callbackUrl: URL, pending: PendingLogin): Promise<Identity>;
}

export class GoogleIdentityProvider implements IdentityProvider {
  private discovered: Promise<oidc.Configuration> | undefined;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  // "Discovery": fetch https://accounts.google.com/.well-known/openid-configuration,
  // which lists Google's endpoints and signing keys. Done lazily on the first
  // login and then reused, so the server can start without network access.
  private configuration(): Promise<oidc.Configuration> {
    this.discovered ??= oidc
      .discovery(new URL("https://accounts.google.com"), this.clientId, this.clientSecret)
      .catch((err: unknown) => {
        this.discovered = undefined; // allow a retry on the next login
        throw err;
      });
    return this.discovered;
  }

  async startLogin() {
    const config = await this.configuration();

    const pending: PendingLogin = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier: oidc.randomPKCECodeVerifier(),
    };

    const redirectUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      // Least privilege: we only need to know who they are. No Drive, no
      // Calendar, no refresh token.
      scope: "openid email profile",
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
      code_challenge_method: "S256",
      // Always show the account chooser, so a rejected user can pick another
      // account instead of being bounced straight back to a 403.
      prompt: "select_account",
    });

    return { redirectUrl: redirectUrl.href, pending };
  }

  async finishLogin(callbackUrl: URL, pending: PendingLogin): Promise<Identity> {
    const config = await this.configuration();

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      pkceCodeVerifier: pending.codeVerifier,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims || typeof claims.email !== "string") {
      throw new Error("ID token has no email claim");
    }

    // The access token is deliberately discarded: we call no Google APIs.
    return {
      email: claims.email,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === "string" ? claims.name : null,
    };
  }
}
