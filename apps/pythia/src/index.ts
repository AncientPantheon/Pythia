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
import { loadOidcConfig } from "./admin/oidcConfig.js";
import { registerAdmin } from "./admin/routes.js";
import { ConnectorStore } from "./connectors/store.js";
import { SettingsStore } from "./admin/settingsStore.js";
import { loadConfigFromDisk } from "./config/index.js";
import { loadHubConfig, HubServiceClient } from "./hub/serviceClient.js";
import { NodePool } from "./pool/nodePool.js";
import type { HubAdminControls } from "./admin/routes.js";
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
const envConsumerMap = loadConsumerMap(process.env.PYTHIA_API_KEYS);

// Runtime connector registry (admin-managed, persisted on the volume). Its keys
// are the primary attribution source; the legacy `PYTHIA_API_KEYS` env map is a
// fallback for any manually-provisioned keys.
export const connectorStore = new ConnectorStore({
  filePath: process.env.CONNECTORS_FILE || "./pythia-connectors.json",
});

// Resolve an `x-pythia-key` to a consumer name: registered connector first, then
// the env map, else the anonymous "direct" bucket.
function resolveConsumer(key?: string): string {
  if (key) {
    const fromStore = connectorStore.nameForKey(key);
    if (fromStore) return fromStore;
    const fromEnv = envConsumerMap.get(key);
    if (fromEnv) return fromEnv;
  }
  return "direct";
}

// Runtime admin settings (the hub feed URL + HMAC secret), set from the
// `ancient`-gated admin UI so the operator activates the feed from the website
// rather than editing env over SSH. Persisted on the `/data` volume.
export const settingsStore = new SettingsStore({
  filePath: process.env.SETTINGS_FILE || "./pythia-settings.json",
});

// The read node-pool: the hub's advertised StoaChain fleet (polled ~60s over the
// signed HMAC feed) enlarges the READ pool, with the checked-in seed nodes as the
// always-present fallback. OPTIONAL: only polls when a hub HMAC secret is present
// (admin settings win over the `PYTHIA_HUB_HMAC_SECRET` env) — absent it, the pool
// is seed-only (today's two-host behavior, zero change). SEND stays on the seeds
// and is never hub-fed. Exported so the server stops the poller on shutdown.
function currentHubConfig() {
  return settingsStore.hubConfig() ?? loadHubConfig();
}
export const nodePool = new NodePool({
  seeds: loadConfigFromDisk().sources,
  client: (() => {
    const cfg = currentHubConfig();
    return cfg ? new HubServiceClient(cfg) : null;
  })(),
});

// The control surface the admin UI drives: read status, set the feed config (then
// hot-reconfigure the pool + poll immediately), or force a refresh. The HMAC
// secret is never returned — only whether one is set.
const hubAdmin: HubAdminControls = {
  status: () => ({
    hubBaseUrl: settingsStore.hubBaseUrl(),
    secretSet: currentHubConfig() !== null,
    fromSettings: settingsStore.hasSecret(),
    slots: nodePool.hubSlotCount(),
  }),
  setConfig: async (hubBaseUrl, hmacSecret) => {
    settingsStore.setHubConfig({ hubBaseUrl, hmacSecret });
    const cfg = currentHubConfig();
    nodePool.reconfigure(cfg ? new HubServiceClient(cfg) : null);
    await nodePool.refreshNow();
    return hubAdmin.status();
  },
  refresh: async () => {
    await nodePool.refreshNow();
    return hubAdmin.status();
  },
};

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
app.use("*", statsMiddleware(statsStore, resolveConsumer));

// API + health routes are registered BEFORE the `/` static catch-all so the
// static handler never shadows `/healthz`, `/stoachain/*`, `/api/v1/*`, or `/stats`.
registerHealthz(app);
registerRead(app, { pool: nodePool });
registerSend(app);
registerPoll(app, { pool: nodePool });
registerConnectors(app, { store: connectorStore });
registerStats(app, statsStore);

// Begin polling the hub feed (no-op when the HMAC secret is unset → seed-only).
nodePool.start();

// The human admin surface (connector manager) is gated on the AncientHoldings
// hub OIDC IdP. It is OPTIONAL: only wired when the deploy-time OIDC secrets are
// present, so the public keyless gateway boots unchanged with no SSO configured.
// Registered before the static catch-all so `/admin/*` is not shadowed.
const oidcConfig = loadOidcConfig();
if (oidcConfig) registerAdmin(app, oidcConfig, connectorStore, hubAdmin);

// Serve the landing page + its assets at `/`. `root` is absolute so it resolves
// the same regardless of where the process was started from. `onFound` stamps
// `Cache-Control: no-cache` on every served asset so the browser REVALIDATES each
// load (via last-modified) — a fresh deploy is visible on a normal refresh
// instead of the browser silently serving a stale index.html/app.js.
app.use(
  "/*",
  serveStatic({
    root: PUBLIC_DIR,
    index: "index.html",
    onFound: (_path, c) => {
      c.header("Cache-Control", "no-cache");
    },
  }),
);

export default app;
