import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { registerHealthz } from "./routes/healthz.js";
import { registerRead } from "./routes/read.js";
import { registerSend } from "./routes/send.js";
import { registerPoll } from "./routes/poll.js";
import { registerConnectors } from "./routes/connectors.js";
import { registerStats } from "./routes/stats.js";
import { registerPools } from "./routes/pools.js";
import { registerConnectorVerify } from "./routes/connectorVerify.js";
import { registerVerifiers } from "./routes/verifiers.js";
import { VerifierStore } from "./verifiers/store.js";
import { corsMiddleware } from "./middleware/cors.js";
import { loadOidcConfig } from "./admin/oidcConfig.js";
import { registerAdmin } from "./admin/routes.js";
import { ConnectorStore } from "./connectors/store.js";
import { SettingsStore } from "./admin/settingsStore.js";
import { TxSenderStore } from "./txsenders/store.js";
import { loadConfigFromDisk } from "./config/index.js";
import { loadHubConfig, HubServiceClient } from "./hub/serviceClient.js";
import { detectEgressIp, cachedEgressIp } from "./hub/egressIp.js";
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

// The Upload Pool: dedicated, ancient-managed nodes for signed-tx `/send` ONLY.
// Seeded on first run with the checked-in seed nodes so sends keep working until
// the admin curates dedicated senders. Persisted on the `/data` volume. It is
// ALSO the read fallback (below) when the hub feed is off/down.
export const txSenderStore = new TxSenderStore({
  filePath: process.env.TXSENDERS_FILE || "./pythia-txsenders.json",
  seeds: loadConfigFromDisk().sources.map((s) => ({ url: s.url, label: s.id })),
});

// The verifier registry: the ancient-admin-curated Apollo-ownership verify
// locations the Connectors "Verify" popup offers. NOT seeded — admins add their
// own (localhost dev ports vary; there is no safe universal default). Persisted
// on the `/data` volume.
export const verifierStore = new VerifierStore({
  filePath: process.env.VERIFIERS_FILE || "./pythia-verifiers.json",
});

// The read node-pool (Observation): the hub's advertised StoaChain fleet (polled
// ~60s over the signed HMAC feed) enlarges the READ pool. When the feed is off or
// down, reads are REDIRECTED to the Upload Pool (the operator's dedicated nodes),
// with the checked-in seeds as the absolute last resort. OPTIONAL feed: only polls
// when a hub HMAC secret is present (admin settings win over the env). SEND stays
// on the Upload Pool only. Exported so the server stops the poller on shutdown.
function currentHubConfig() {
  return settingsStore.hubConfig() ?? loadHubConfig();
}
export const nodePool = new NodePool({
  client: (() => {
    const cfg = currentHubConfig();
    return cfg ? new HubServiceClient(cfg) : null;
  })(),
  uploadNodes: () => txSenderStore.enabledNodes(),
});

// Detect Pythia's public egress IP (the hub allowlist target) at boot; refreshed
// on admin refresh. Non-blocking — the value populates shortly after start.
void detectEgressIp();

// The control surface the admin UI drives: read status, set the feed config (then
// hot-reconfigure the pool + poll immediately), or force a refresh. The HMAC
// secret is never returned — only whether one is set.
function secretMask(): string {
  const secret = currentHubConfig()?.secret;
  return secret ? `…${secret.slice(-4)}` : "";
}
const hubAdmin: HubAdminControls = {
  status: () => {
    const health = nodePool.feedHealth();
    return {
      hubBaseUrl: settingsStore.hubBaseUrl(),
      secretSet: currentHubConfig() !== null,
      fromSettings: settingsStore.hasSecret(),
      slots: health.slots,
      secretMask: secretMask(),
      feedOk: health.configured && health.ok,
      feedError: health.error,
      egressIp: cachedEgressIp(),
    };
  },
  setConfig: async (hubBaseUrl, hmacSecret) => {
    settingsStore.setHubConfig({ hubBaseUrl, hmacSecret });
    const cfg = currentHubConfig();
    nodePool.reconfigure(cfg ? new HubServiceClient(cfg) : null);
    await nodePool.refreshNow();
    return hubAdmin.status();
  },
  refresh: async () => {
    await Promise.all([nodePool.refreshNow(), detectEgressIp()]);
    return hubAdmin.status();
  },
  revealSecret: () => currentHubConfig()?.secret ?? null,
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
registerSend(app, { store: txSenderStore });
registerPoll(app, { pool: nodePool });
registerConnectors(app, { store: connectorStore });
registerStats(app, statsStore);
registerPools(app, { pool: nodePool, txSenders: txSenderStore });
// Connector-linking ownership verification (keyless Apollo-half proof). Reads the
// half's on-chain pubkey — preferring the operator's own Upload-Pool nodes as the
// trust anchor, hub read pool as fallback — and verifies the browser's signature.
// Pythia never signs. Not admin-gated: anyone links their own keys.
registerConnectorVerify(app, { pool: nodePool, txSenders: txSenderStore });
// Public list of admin-curated Apollo-ownership verifiers for the Verify popup.
registerVerifiers(app, { store: verifierStore });

// Begin polling the hub feed (no-op when the HMAC secret is unset → seed-only).
nodePool.start();

// The human admin surface (connector manager) is gated on the AncientHoldings
// hub OIDC IdP. It is OPTIONAL: only wired when the deploy-time OIDC secrets are
// present, so the public keyless gateway boots unchanged with no SSO configured.
// Registered before the static catch-all so `/admin/*` is not shadowed.
const oidcConfig = loadOidcConfig();
if (oidcConfig)
  registerAdmin(app, oidcConfig, connectorStore, {
    hubAdmin,
    txSenders: txSenderStore,
    verifiers: verifierStore,
  });

// The dedicated ancient-admin dashboard page. Served as its own document at
// `/admin` (distinct from the `/admin/*` OIDC + admin-API routes above, which are
// registered first and win). The page is public HTML with no secrets — it reads
// `GET /api/me` and gates ITSELF client-side, and every mutation it makes hits an
// ancient-gated `/admin/*` API, so serving the shell to anyone is safe. Read per
// request so a fresh deploy is served without a restart.
const ADMIN_HTML = join(PUBLIC_DIR, "admin.html");
app.get("/admin", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(readFileSync(ADMIN_HTML, "utf8"));
});

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
