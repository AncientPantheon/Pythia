import { serve } from "@hono/node-server";
import { app, statsStore, nodePool, pythLedger } from "./index.js";
import { resolvePort } from "./port.js";

const port = resolvePort();

// Boot the wired read gateway over @hono/node-server. This is the entry the
// Dockerfile `CMD` runs (node dist/server.js) and the `start` script mirrors.
serve({ fetch: app.fetch, port }, (info) => {
  // Structured boot line so the container logs show the live bind address.
  console.log(`pythia listening on http://0.0.0.0:${info.port}`);
});

// Persist the usage-analytics snapshot before the container tears down so the
// in-flight aggregates survive a restart. Flush is atomic + non-fatal.
function shutdown(signal: string): void {
  console.log(`pythia received ${signal} — flushing stats and exiting`);
  statsStore.flush();
  statsStore.stop();
  pythLedger.persist();
  pythLedger.stop();
  nodePool.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
