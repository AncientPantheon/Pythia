import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { registerHealthz } from "./routes/healthz.js";
import { registerRead } from "./routes/read.js";
import { registerSend } from "./routes/send.js";
import { registerPoll } from "./routes/poll.js";
import { registerConnectors } from "./routes/connectors.js";
import { registerStats } from "./routes/stats.js";
import { corsMiddleware } from "./middleware/cors.js";
import { loadConfigFromDisk } from "./config/index.js";
import { StatsStore } from "./stats/store.js";
import { loadConsumerMap } from "./stats/consumers.js";
import { statsMiddleware } from "./stats/middleware.js";

/**
 * The Pythia gateway application.
 *
 * A bootable Hono instance wired as a KEYLESS generic per-chain transport
 * gateway over Pythia's own two-host failover dial:
 * `GET /healthz` (service liveness + per-source reachability + active routing),
 * `POST /stoachain/read` (generic dirty read — the caller supplies the Pact
 * code; the node response is returned verbatim, never decoded),
 * `POST /stoachain/send` (keyless broadcast — relays the caller-SIGNED `cmds`
 * verbatim to the node's /send) and `POST /stoachain/poll` (per-request-key tx
 * status + depth). Pythia never holds keys and never signs — it only relays
 * caller-supplied payloads in either direction.
 *
 * It also serves the static landing page at `/` (source-health list + connector
 * links) plus `GET /api/v1/connectors` (the config-driven connector list). The
 * landing surface is read-only — it polls `/healthz` and reads connectors.
 */
export const app = new Hono();

// Usage analytics: an in-memory aggregate (day/consumer/chain/endpoint/ok) with
// atomic JSON-snapshot persistence, plus the consumer key→name map loaded from
// the DEPLOY-TIME `PYTHIA_API_KEYS` secret (NOT the public repo config). The
// store is exported so the server can flush it on shutdown.
export const statsStore = new StatsStore({
  filePath: process.env.STATS_FILE || "./pythia-stats.json",
});
const consumerMap = loadConsumerMap(process.env.PYTHIA_API_KEYS);

// The hand-written static landing assets, resolved relative to this module so
// serving is independent of the process CWD (container runs from /app, local
// `npm start` runs from apps/pythia). dist layout mirrors src, so from
// dist/index.js the assets sit at ../public.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Browser apps read StoaChain data THROUGH Pythia cross-origin, so CORS is
// applied to every route before the handlers. The allowlist is operator-tunable
// via config `corsOrigins`; absent/empty falls back to a permissive wildcard
// for this public read-only gateway. Same-origin static assets are unaffected.
app.use("*", corsMiddleware(loadConfigFromDisk().corsOrigins));

// Usage analytics runs before the route handlers so it can observe each
// operational request's final status. It only counts `/{chain}/{read|send|poll}`
// (health/static/connectors are ignored) and records nothing else — keyless, it
// never signs or broadcasts.
app.use("*", statsMiddleware(statsStore, consumerMap));

// API + health routes are registered BEFORE the `/` static catch-all so the
// static handler never shadows `/healthz`, `/stoachain/*`, `/api/v1/*`, or `/stats`.
registerHealthz(app);
registerRead(app);
registerSend(app);
registerPoll(app);
registerConnectors(app);
registerStats(app, statsStore);

// Serve the landing page + its assets at `/`. `root` is absolute so it resolves
// the same regardless of where the process was started from.
app.use("/*", serveStatic({ root: PUBLIC_DIR, index: "index.html" }));

export default app;
