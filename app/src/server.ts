// Entry point: load config, build the app, listen.

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`Serving ${config.fileRoot} at http://${config.host}:${config.port}`);
});

// Docker stops containers with SIGTERM. Finish in-flight requests, then exit,
// instead of being killed mid-response.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
