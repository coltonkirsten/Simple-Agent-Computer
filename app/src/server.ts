// Entry point: load config, build the app, listen.

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GoogleIdentityProvider } from "./identity.js";

const config = loadConfig();
const google = new GoogleIdentityProvider(
  config.googleClientId,
  config.googleClientSecret,
  `${config.baseUrl}/auth/callback`,
);
const app = createApp(config, google);

const server = app.listen(config.port, config.host, () => {
  // Print BASE_URL, not host:port — it's the only origin login works from.
  console.log(`Serving ${config.fileRoot} at ${config.baseUrl}`);
  console.log(`Listening on ${config.host}:${config.port}`);
  console.log(`Allowlist: ${config.allowedEmails.size} account(s)`);
});

// Docker stops containers with SIGTERM. Finish in-flight requests, then exit,
// instead of being killed mid-response.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
