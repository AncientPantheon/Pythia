import { serve } from "@hono/node-server";
import { resolvePort } from "./port.js";
import { ensureSodiumReady } from "./codex/vault.js";

// Boot the wired read gateway. libsodium must be initialised BEFORE `./index.js` is
// evaluated, because the vault-backed stores it constructs seal/unseal through it —
// so index.js is a dynamic import AFTER `ensureSodiumReady()`.
async function main(): Promise<void> {
  await ensureSodiumReady();
  const { app, statsStore, nodePool, pythLedger, txTracker, usageReporter } =
    await import("./index.js");

  const port = resolvePort();
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
    txTracker.stop();
    usageReporter.stop();
    nodePool.stop();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
