// All configuration comes from environment variables, read once at startup.

import path from "node:path";

export interface Config {
  /** Directory exposed by the explorer. On the VM this will be /host. */
  fileRoot: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    fileRoot: path.resolve(env.FILE_ROOT ?? "."),
    // Localhost only by default: there is no login yet (Phase 6), so the app
    // must not be reachable from the network.
    host: env.HOST ?? "127.0.0.1",
    port,
  };
}
