import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { registerHealthz } from "./routes/healthz.js";
import { registerRead } from "./routes/read.js";
import { registerSend } from "./routes/send.js";
import { registerPoll } from "./routes/poll.js";
import { registerConnectors } from "./routes/connectors.js";
import { registerStats } from "./routes/stats.js";
import { registerPyth } from "./routes/pyth.js";
import { registerPythReport } from "./routes/pythReport.js";
import { loadReporters } from "./pyth/reporters.js";
import { makeResolveConsumer } from "./stats/consumerResolver.js";
import { PYTHIA_SELF_CONSUMER, setPythiaSelfConsumer } from "./automaton/khronoton/meteredRuntime.js";
import { registerPools } from "./routes/pools.js";
import { registerConnectorVerify, trustAnchorPair } from "./routes/connectorVerify.js";
import { registerConnectorAuth } from "./routes/connectorAuth.js";
import { registerVerifiers } from "./routes/verifiers.js";
import { DualLinkCache, readActiveDualLinkAccounts } from "./connectors/auth/dualLinkCache.js";
import { AuthNonceStore } from "./connectors/auth/nonceStore.js";
import { EphemeralKeyStore } from "./connectors/auth/ephemeralKeyStore.js";
import { connectorGateMiddleware } from "./connectors/auth/gateMiddleware.js";
import { firstPartyKeyMiddleware } from "./connectors/auth/effectiveKey.js";
import { readApolloPublicKey } from "./connectors/verify/readApolloPublicKey.js";
import { readApolloCounterpart } from "./connectors/auth/readApolloCounterpart.js";
import { PendingActivationTracker } from "./connectors/auth/pendingActivationTracker.js";
import { PendingBreakTracker } from "./connectors/auth/pendingBreakTracker.js";
import { registerAdminDeploy } from "./routes/adminDeploy.js";
import { VerifierStore } from "./verifiers/store.js";
import { corsMiddleware } from "./middleware/cors.js";
import { loadOidcConfig } from "./admin/oidcConfig.js";
import { registerConnectorBreak } from "./automaton/khronoton/connectorBreakRoute.js";
import { registerAdmin } from "./admin/routes.js";
import { ConnectorStore } from "./connectors/store.js";
import { SettingsStore } from "./admin/settingsStore.js";
import { SealedStore } from "./codex/sealedStore.js";
import { CodexStore } from "./automaton/codexStore.js";
import { registerCodexAdmin } from "./automaton/codexAdmin.js";
import { registerKhronotonAdmin } from "./automaton/khronoton/admin.js";
import { fetchAvailableVersion, isNewer } from "./admin/versionInfo.js";
import { collectOrganVersions } from "./admin/organVersions.js";
import { PYTHIA_VERSION } from "./version.js";
import { TxSenderStore } from "./txsenders/store.js";
import { loadConfigFromDisk } from "./config/index.js";
import { loadHubConfig, HubServiceClient } from "./hub/serviceClient.js";
import { detectEgressIp, cachedEgressIp } from "./hub/egressIp.js";
import { NodePool } from "./pool/nodePool.js";
import { probeNodes } from "./health/probeNodes.js";
import { enrichHubNodes } from "./hub/hubNodes.js";
import type { HubAdminControls, SelfConnectorStatus, SelfConnectorHalfView } from "./admin/routes.js";
import { SelfApolloVault } from "./automaton/selfApollo.js";
import { SelfConnectorLoop } from "./automaton/selfConnectorLoop.js";
import type { SelfConnectorHalfStatus } from "./automaton/selfConnectorLoop.js";
import {
  isPythiaKhronotonLoopRunning,
  areAutomatonResolversRegistered,
} from "./automaton/khronoton/register.js";
import { maskSecret } from "@ancientpantheon/pythia-client";
import { createInProcessFetch } from "./connectors/self/inProcessFetch.js";
import { StatsStore } from "./stats/store.js";
import { loadConsumerMap } from "./stats/consumers.js";
import { statsMiddleware } from "./stats/middleware.js";
import { PythLedger } from "./pyth/ledger.js";
import { PythEpochStore } from "./pyth/epoch.js";
import { createEpochReader } from "./pyth/epochReader.js";
import { pythMeterMiddleware } from "./pyth/meter.js";
import { TxTracker } from "./pyth/txTracker.js";
import { pollExecution } from "./reads/index.js";
import { SlotUsageMeter } from "./stats/slotUsage.js";
import { UsageReporter } from "./stats/usageReporter.js";

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

// The Pyth ledger: Pythia's own keyless economic odometer (petitions, pondus,
// transactions, gas) — see pyth/ledger.ts. Persisted on the mounted volume;
// mirrors the on-chain schema so a future Dalos flush can read the day deltas.
// The ledger epoch (day-1 anchor): read once from chain (PYTHIA.UR_PythLedgerEpochStart)
// and cached on the volume; falls back to the hardcoded constant until that read lands.
// Constructed before the ledger, which reads its epoch getter for day-ordinal math.
export const pythEpoch = new PythEpochStore({
  filePath: process.env.PYTH_EPOCH_FILE || "./pythia-pyth-epoch.json",
});
export const pythLedger = new PythLedger({
  filePath: process.env.PYTH_LEDGER_FILE || "./pythia-pyth-ledger.json",
  epochMs: () => pythEpoch.epochMs(),
});
const envConsumerMap = loadConsumerMap(process.env.PYTHIA_API_KEYS);
// Consumer names permitted to POST /pyth/report (metering-report ingress). Empty
// by default — the ingress is closed until an operator names authorized reporters.
const pythReporters = loadReporters(process.env.PYTHIA_REPORTERS);

// Runtime connector registry (admin-managed, persisted on the volume). Its keys
// are the primary attribution source; the legacy `PYTHIA_API_KEYS` env map is a
// fallback for any manually-provisioned keys.
export const connectorStore = new ConnectorStore({
  filePath: process.env.CONNECTORS_FILE || "./pythia-connectors.json",
});

// A RANDOM per-process marker (read-gate-self-key). `firstPartyKeyMiddleware` injects
// it as the effective key for same-origin keyless reads WHEN Pythia has no active self
// secret, and the resolver maps it back to `pythia-self` (unkeyed) — so her own website
// stays readable in the brief windows the self secret is absent (e.g. right after a
// deploy). It is never sent to any client and is unguessable, so it can't be presented
// by an external caller to masquerade as Pythia.
const FIRST_PARTY_MARKER = `fp_${randomBytes(24).toString("base64url")}`;

// Resolve an `x-pythia-key` to a consumer identity for usage attribution — see
// `stats/consumerResolver.ts` for the precedence + rationale. Pythia's OWN key
// (keyless reads + her fires) unifies under `PYTHIA_SELF_CONSUMER`. The closures
// reference the module stores lazily (evaluated per request, after boot), so this
// const can sit before those `export const`s are initialized.
const resolveConsumerFull = makeResolveConsumer({
  selfSecret: () => selfConnectorLoop.status().secret,
  resolveEphemeral: (secret) => ephemeralKeyStore.resolve(secret),
  nameForKey: (key) => connectorStore.nameForKey(key),
  envConsumer: (key) => envConsumerMap.get(key),
  // Pythia's own reads unify under her self dual-link Apollo (her KEYED 24h self-connector),
  // NOT a separate "pythia-self" bucket — a getter (lazily resolved per request, after boot,
  // like the closures above). Falls back to "pythia-self" until her dual-link-key is pasted.
  selfLabel: () => selfApolloVault.standardAccount() || PYTHIA_SELF_CONSUMER,
  firstPartyMarker: FIRST_PARTY_MARKER,
});
// The meter needs both the consumer AND the keyed/earning flag; stats + the report
// gate only need the consumer NAME.
const resolveConsumer = (key?: string): string => resolveConsumerFull(key).consumer;

// The canonical Pantheonic vault (`automaton/02`, libsodium — the same scheme as the
// hub + Mnemosyne). Bearer creds Pythia must USE (the hub HMAC secret; soon the Codex
// snapshot + password) are sealed at rest under `PYTHIA_MASTER_KEY` (32-byte base64),
// server-held auto-unlock. Requires `ensureSodiumReady()` before use — server.ts awaits
// it before this module is imported. With no master key (dev), the store is locked and
// the settings store falls back to plaintext. Persisted on the `/data` volume.
export const sealedVault = new SealedStore({
  dir: process.env.PYTHIA_VAULT_DIR || "./pythia-vault",
});

// Runtime admin settings (the hub feed URL + HMAC secret), set from the
// `ancient`-gated admin UI so the operator activates the feed from the website
// rather than editing env over SSH. Persisted on the `/data` volume. The HMAC
// secret is sealed through the vault above when a master key is present.
export const settingsStore = new SettingsStore({
  filePath: process.env.SETTINGS_FILE || "./pythia-settings.json",
  vault: sealedVault,
});

// Pythia's server-custody Codex (the keyed automaton half): the snapshot + machine
// password sealed in the canonical vault above. Shared by the codex admin routes AND
// the Khronoton key resolver (which signs Pythia's own transactions).
export const codexStore = new CodexStore(sealedVault);

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
// down, reads are REDIRECTED to the Upload Pool (the operator's dedicated nodes —
// itself seeded from the checked-in config on first run; there is no separate seed
// tier). OPTIONAL feed: only polls
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

// The self-polling tx-outcome tracker: relay-accepted sends are handed here, and
// it polls chainweb (keyless — a plain read over the pool) until each tx mines,
// then records the REAL outcome into the Pyth ledger (success → transaction +
// actual gas; revert → failed + wasted gas; never-mined → timed out as failed).
export const txTracker = new TxTracker({
  ledger: pythLedger,
  poll: async (requestKeys) => {
    const pair = nodePool.pickReadPair();
    if (!pair) return new Map();
    return pollExecution(requestKeys, 0, { primary: pair.primary, fallback: pair.fallback });
  },
});

// The connector-auth system (docs/work/pythia-connector-protocol/design.md,
// docs/work/connector-auth-core/plan.md): the headless challenge/verify round
// trip that mints a TTL'd, gated `x-pythia-key` for a consumer who proves (via
// the Codex-side signer — see the design's companion handoff) ownership of an
// ACTIVE on-chain Apollo DualLink, with no browser/cookie involved. Three
// pieces, wired here at the composition root like every other store above:
//  - dualLinkCache: a cached mirror of the on-chain active-DualLink set,
//    polled through a FRESH `trustAnchorPair()` each tick (mirrors
//    txTracker's poll closure above) so it always reads via a currently-live
//    pair rather than one pinned at boot. `readActiveDualLinkAccounts` REJECTS
//    on any read failure (including "no pair available"), which is what keeps
//    `DualLinkCache`'s fail-closed, keep-last-good-on-error behavior intact.
//  - authNonceStore: single-use, TTL'd headless challenge nonces.
//  - ephemeralKeyStore: the minted bearer secrets the gate middleware below
//    checks on every operational request.
//
// Both reads below are pinned to `trustAnchorPair()` — the SAME preference
// `registerConnectorVerify` already uses (operator's own Upload-Pool nodes
// FIRST, the externally-advertised hub pool only as fallback) — not a raw
// `nodePool.pickReadPair()`. A single dishonest hub-fed node must not be able
// to forge either the active-dual-link membership answer or the Apollo
// public key that gates ephemeral-secret issuance; reading straight off the
// hub rotation would let it do exactly that.
export const dualLinkCache = new DualLinkCache({
  poll: async () => {
    const pair = trustAnchorPair({ pool: nodePool, txSenders: txSenderStore });
    if (!pair) throw new Error("pythia dual-link cache: no read pair available");
    return readActiveDualLinkAccounts(pair);
  },
});
export const authNonceStore = new AuthNonceStore();
// Volume-backed (like connectorStore) so a gateway restart / deploy does NOT
// orphan every consumer's live ephemeral key — set EPHEMERAL_KEYS_FILE to the
// mounted-volume path in prod (same volume as CONNECTORS_FILE).
export const ephemeralKeyStore = new EphemeralKeyStore({
  filePath: process.env.EPHEMERAL_KEYS_FILE || "./pythia-ephemeral-keys.json",
});

// Resolves a headless-verify caller's on-chain Apollo public key for
// `registerConnectorAuth` below. `readApolloPublicKey` itself takes an
// INJECTED `{primary, fallback}` pair (see connectors/verify/readApolloPublicKey.ts —
// it never picks its own), so this wrapper gets a fresh pair the same way the
// dual-link poll above does: via `trustAnchorPair()`, called fresh per call.
// `ConnectorAuthDeps.readApolloPublicKey` is typed `Promise<string>`
// (non-nullable), so a missing pair or a not-found on-chain key is surfaced by
// throwing — the verify route catches it and turns it into a JSON error.
async function readApolloPublicKeyForAuth(account: string): Promise<string> {
  const pair = trustAnchorPair({ pool: nodePool, txSenders: txSenderStore });
  if (!pair) throw new Error("pythia connector auth: no read pair available");
  const key = await readApolloPublicKey(pair, account);
  if (!key) throw new Error(`pythia connector auth: no on-chain public key for ${account}`);
  return key;
}

// The connector-activation-resolver pairing store (docs/work/connector-activation-resolver):
// records each independently-proven Apollo half (via `registerConnectorAuth`'s verify
// route below) until BOTH halves of the same on-chain `DualLink` pair are in, at which
// point the `dual-link-activate` Khronoton resolver (wired from `khronoton/register.ts`)
// fires the on-chain activation. Exported the same way `dualLinkCache`/`authNonceStore`
// above are — a single shared instance threaded to both the HTTP route (record side) and
// the Khronoton engine (fire side).
export const pendingActivationTracker = new PendingActivationTracker();
// The operator-initiated DEACTIVATION ("API Break") queue — the ancient-gated
// /admin/connectors/break route records the selected dual-link-key here, and the
// dual-link-break resolver drains it into the on-chain A_RevokeLink tx.
export const pendingBreakTracker = new PendingBreakTracker();

// Pythia consuming her OWN connector protocol on her own behalf
// (docs/work/pythia-self-consumer/design.md): a sealed-vault-backed dual-Apollo
// identity (`selfApollo.ts`) driven through a `PythiaConnector`-per-half loop
// (`selfConnectorLoop.ts`) that talks to Pythia's OWN routes in-process — never
// a real network hairpin — via `createInProcessFetch(app)` below. `app` and
// `sealedVault` are both already constructed above this point.
export const selfApolloVault = new SelfApolloVault(sealedVault, codexStore);
export const selfConnectorLoop = new SelfConnectorLoop({
  baseUrl: "http://pythia.self",
  fetchImpl: createInProcessFetch(app),
  vault: selfApolloVault,
});
// Route Pythia's OWN Khronoton fires (meterChainRuntime) to the SAME identity her reads
// use — her self dual-link Apollo — so all her activity (reads + fires) lands in one KEYED
// bucket (her 24h self-connector), not a separate "pythia-self" row. Falls back to
// "pythia-self" until her dual-link-key is pasted. Set once at boot (the resolver reads the
// same getter via selfLabel above).
setPythiaSelfConsumer(() => selfApolloVault.standardAccount() || PYTHIA_SELF_CONSUMER);

// Resolves a just-proven Apollo account's on-chain counterpart for
// `registerConnectorAuth` below, so a successful verify for a NOT-yet-active account can
// be recorded into `pendingActivationTracker`. Same `trustAnchorPair()`-per-call pattern
// as `readApolloPublicKeyForAuth` above (a fresh pair every call, never one pinned at
// boot). Unlike that wrapper, `ConnectorAuthDeps.readApolloCounterpart` IS typed
// `Promise<string | null>` — a well-formed "not linked yet" read is a legitimate `null`,
// not an error — but a missing read pair is still surfaced by throwing, mirroring
// `readApolloPublicKeyForAuth`'s "no pair available" behavior exactly.
async function readApolloCounterpartForAuth(account: string): Promise<string | null> {
  const pair = trustAnchorPair({ pool: nodePool, txSenders: txSenderStore });
  if (!pair) throw new Error("pythia connector auth: no read pair available");
  return readApolloCounterpart(pair, account);
}

// The per-slot windowed usage meter (the money path) — hub-slot reads only,
// keyed/anon/ok + keyedPondus. Drained + reported to the hub by the usage
// reporter (CP3), gated by the report toggle.
export const slotUsage = new SlotUsageMeter();

// The usage reporter: every ~60s it drains the slot window and POSTs it to the
// hub (the money path), honoring the report toggle + the window contract. A
// fresh HubServiceClient per tick (cheap, stateless) reflects the current config.
export const usageReporter = new UsageReporter({
  meter: slotUsage,
  client: () => {
    const cfg = currentHubConfig();
    return cfg ? new HubServiceClient(cfg) : null;
  },
  reportEnabled: () => settingsStore.reportEnabled(),
});

// Detect Pythia's public egress IP (the hub allowlist target) at boot; refreshed
// on admin refresh. Non-blocking — the value populates shortly after start.
void detectEgressIp();

// Read + cache the ledger epoch from chain once at boot (best-effort, non-fatal). Uses
// the node pool's read path; the ledger already serves day ordinals off the default
// until this lands. Surfaced in the admin (StoaChain Earnings).
void pythEpoch.resolve(createEpochReader(nodePool));

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

// Read-gate + self-key seam (docs/work/read-gate-self-key/design.md). ORDER MATTERS:
//   1. first-party self-key injection — a same-origin (Sec-Fetch-Site: same-origin)
//      operational read with NO x-pythia-key gets Pythia's own self secret injected as
//      its effective key, so her website's keyless fetches attribute to `pythia-self`
//      and clear the gate. Secret never leaves the server; the automaton (which reads
//      via dial() server-side, not over HTTP) is untouched.
//   2. HARD gate — reject any operational request whose effective key resolves to the
//      unrecognized "direct" bucket (no key, or unknown/expired key). Runs BEFORE the
//      meters, so a rejected request is NEVER counted — the "direct"/Anonymous bucket
//      can no longer reappear in the ledger or /stats.
//   3. stats + pyth metering — now only ever see served (recognized) requests.
app.use("*", firstPartyKeyMiddleware(() => selfConnectorLoop.status().secret, FIRST_PARTY_MARKER));
app.use("*", connectorGateMiddleware(resolveConsumerFull));

// Usage analytics — counts `/{chain}/{read|send|poll}` (health/static/connectors are
// ignored). Keyless; never signs or broadcasts.
app.use("*", statsMiddleware(statsStore, resolveConsumer));

// Pyth-economy metering — keyed reads/polls → Petitions + Pondus, sends →
// Transactions/Gas (accepted) or Failed/Wasted (rejected). Reads only response
// gas/bytes + the caller's gasLimit; it never signs.
app.use(
  "*",
  pythMeterMiddleware(pythLedger, resolveConsumerFull, txTracker, {
    usage: slotUsage,
    operatorForSlot: (id) => nodePool.operatorForSlot(id),
  }),
);

// API + health routes are registered BEFORE the `/` static catch-all so the
// static handler never shadows `/healthz`, `/stoachain/*`, `/api/v1/*`, or `/stats`.
registerHealthz(app, {
  pool: nodePool, // pool-aware: reflects the nodes actually serving reads
  // The automaton liveness ("green check") flags, read truthfully at request time.
  // Computed HERE in the composition root — the only place allowed to reach the
  // automaton core (the keyless request-path modules must not import it).
  capabilities: () => {
    const loop = selfConnectorLoop.status();
    return {
      khronotonTick: isPythiaKhronotonLoopRunning(),
      activationPipeline: areAutomatonResolversRegistered(),
      // Pythia's own dual API link is online iff an ephemeral secret is active
      // (standard-preferred, smart-fallback, null when neither half is active).
      selfConnectorLinked: loop.secret !== null,
      verifiersRegistered: verifierStore.enabled().length,
    };
  },
});
registerRead(app, { pool: nodePool });
registerSend(app, { store: txSenderStore });
registerPoll(app, { pool: nodePool });
registerConnectors(app, { store: connectorStore });
registerStats(app, statsStore);
registerPyth(app, pythLedger);
// Metering-report ingress — an AUTHORIZED reporter (an entity with its own direct
// node access, e.g. the AncientHub/Dalos) records batched txs+reads it performed
// without relaying through the gateway. Gated to `PYTHIA_REPORTERS`; fleet-ledger
// only. `/pyth/report` is not an operational path, so the gateway meter never
// double-counts it. See routes/pythReport.ts + pyth/reporters.ts.
registerPythReport(app, { ledger: pythLedger, resolveConsumer, reporters: pythReporters });
registerPools(app, { pool: nodePool, txSenders: txSenderStore });
// Connector-linking ownership verification (keyless Apollo-half proof). Reads the
// half's on-chain pubkey — preferring the operator's own Upload-Pool nodes as the
// trust anchor, hub read pool as fallback — and verifies the browser's signature.
// Pythia never signs. Not admin-gated: anyone links their own keys.
registerConnectorVerify(app, {
  pool: nodePool,
  txSenders: txSenderStore,
  // On both halves proving ownership in the browser flow, queue the pair for
  // autonomous activation — the SAME tracker the headless connectorAuth flow feeds.
  pendingActivation: pendingActivationTracker,
});
// Headless challenge/verify round trip (connector-auth-core): mints TTL'd
// ephemeral secrets for a consumer who proves ownership of an active on-chain
// DualLink via signature — parallel to (not replacing) the browser Link-verify
// flow above; no cookie/session involved.
registerConnectorAuth(app, {
  nonceStore: authNonceStore,
  ephemeralKeyStore,
  dualLinkCache,
  readApolloPublicKey: readApolloPublicKeyForAuth,
  readApolloCounterpart: readApolloCounterpartForAuth,
  pendingActivation: pendingActivationTracker,
  isSelfAccount: (account) =>
    account === selfApolloVault.standardAccount() || account === selfApolloVault.smartAccount(),
});
// Public list of admin-curated Apollo-ownership verifiers for the Verify popup.
registerVerifiers(app, { store: verifierStore });

// Begin polling the hub feed (no-op when the HMAC secret is unset → seed-only).
nodePool.start();

// Begin the tx-outcome resolution loop (records execution-level send metrics).
txTracker.start();

// Begin the ~60s usage-report loop (drains the slot window → hub; toggle-gated).
usageReporter.start();

// Begin polling the on-chain active-DualLink set, the ephemeral-secret TTL
// sweep loop (connector-auth-core), and the pending-activation-pairing TTL
// sweep loop (connector-activation-resolver).
dualLinkCache.start();
ephemeralKeyStore.start();
pendingActivationTracker.start();

// Begin Pythia's own self-connector refresh loop (see `selfApolloVault`/
// `selfConnectorLoop` above) — a no-op tick for either half until a
// dual-link-key (generated + activated via the admin "Codex" tab) has been
// pasted into the admin "Self Connector" panel. `start()` itself fires an
// immediate tick (in addition to the periodic one) — see its own doc comment
// for why: a dual-link-key pasted in a PRIOR process lifetime is sealed and
// survives a restart, but every redeploy otherwise left the admin staring at
// a false "not-linked" for up to 24h regardless.
selfConnectorLoop.start();

// The human admin surface (connector manager) is gated on the AncientHoldings
// hub OIDC IdP. It is OPTIONAL: only wired when the deploy-time OIDC secrets are
// present, so the public keyless gateway boots unchanged with no SSO configured.
// Registered before the static catch-all so `/admin/*` is not shadowed.
// Computes the admin "Self Connector" panel's status from the two live
// pieces above (`selfApolloVault` + `selfConnectorLoop`) — a named local
// function so `status()` and `link()` in the extras object below can both
// call it without either referring back into the object being constructed.
// Maps each half's `SelfConnectorHalfStatus` (from the
// now `DualLinkConnector`-backed loop — see docs/work/self-connector-dual-link)
// onto the admin-facing `SelfConnectorHalfView` — just its state now: the
// ephemeral secret is a single top-level value (see `selfConnectorStatus`
// below), not a per-half one (docs/work/self-connector-panel-redesign) —
// mirrors `admin/routes.test.ts`'s already-tested "REAL wiring" `makeRealApp`
// helper's `toHalfView` exactly.
function toHalfView(half: SelfConnectorHalfStatus): SelfConnectorHalfView {
  return { state: half.status };
}
async function selfConnectorStatus(): Promise<SelfConnectorStatus> {
  const loop = selfConnectorLoop.status();
  return {
    standardAccount: selfApolloVault.standardAccount(),
    smartAccount: selfApolloVault.smartAccount(),
    dualLinkKey: selfApolloVault.dualLinkKey(),
    standard: toHalfView(loop.standard),
    smart: toHalfView(loop.smart),
    maskedSecret: loop.secret ? maskSecret(loop.secret) : null,
    expiresAt: loop.expiresAt,
  };
}

const oidcConfig = loadOidcConfig();
if (oidcConfig) {
  registerAdmin(app, oidcConfig, connectorStore, {
    hubAdmin,
    txSenders: txSenderStore,
    verifiers: verifierStore,
    // The "StoaChain Earnings" panel: reset the Pyth ledger + toggle hub reporting.
    pyth: {
      total: () => pythLedger.total() as unknown as Record<string, number>,
      nuke: () => pythLedger.nuke(),
      reportEnabled: () => settingsStore.reportEnabled(),
      setReportEnabled: (on) => settingsStore.setReportEnabled(on),
      unflushedDays: () => pythLedger.unflushedDayCount(),
      epoch: () => pythEpoch.status(),
      flushEntries: () => pythLedger.previewEntries() as unknown as Array<Record<string, number | boolean>>,
    },
    // The "Security" panel: sealed-vault status + decommission (clear). Secret
    // values are set in the Hub-feed panel (which seals them via the vault).
    // Scoped to the hub secret ONLY — `sealedVault` is shared with the Codex
    // organ's signing custody (codexStore.ts), so a whole-vault clear() here
    // would also destroy Khronoton's signing password + snapshot backup.
    security: {
      status: () => settingsStore.securityStatus(),
      clear: () => settingsStore.setHubConfig({ hmacSecret: "" }),
    },
    // The Observation Pool node table: every advertised hub node, probed for
    // reachability from Pythia's own vantage (the contract the hub feed must meet).
    hubNodes: {
      list: async () => {
        const advertised = nodePool.advertisedSlots();
        const reach = await probeNodes(advertised.map((s) => s.url));
        return enrichHubNodes(advertised, reach);
      },
    },
    // Update & Deploy version readout: what's running vs what a deploy would build
    // (the repo's `main`). Best-effort — `available` is null if the repo is unreachable.
    versionInfo: {
      get: async () => {
        // Entity + organs read concurrently; each degrades independently.
        const [available, organs] = await Promise.all([
          fetchAvailableVersion(),
          collectOrganVersions(),
        ]);
        return {
          installed: PYTHIA_VERSION,
          available,
          updateAvailable: available ? isNewer(available, PYTHIA_VERSION) : false,
          organs,
        };
      },
    },
    // The "Self Connector" panel: Pythia's own dual-Apollo identity — read
    // status, or link a dual-link-key generated + activated via the Codex tab.
    selfConnector: {
      status: () => selfConnectorStatus(),
      link: async (dualLinkKey: string) => {
        selfApolloVault.setDualLinkKey(dualLinkKey);
        // Drive an IMMEDIATE tick rather than leaving the admin staring at
        // "not-linked" until the next scheduled interval fires — for
        // Pythia's own self-connector that's up to 24h away (see
        // selfConnectorLoop.ts's DEFAULT_INTERVAL_MS). tick() never throws
        // (DualLinkConnector isolates each half's own failure internally,
        // and the construction try/catch here is itself defended), so this
        // is safe to await directly — a real, current attempt against the
        // actual chain state is exactly what "Link" should mean to an
        // admin who just pasted a key.
        await selfConnectorLoop.tick();
        return selfConnectorStatus();
      },
    },
  });
  // On-box blue-green Deploy API (Update & Deploy panel backend): ancient-gated,
  // same OIDC config as the rest of the admin surface. See ./routes/adminDeploy.ts.
  registerAdminDeploy(app, oidcConfig);

  // The Codex organ (the keyed sovereign half): the server-custody adapter + the
  // load/download/reload flows behind the codex-ui. Composition-root wiring of the
  // automaton core — the client request path never reaches it. See src/automaton/.
  registerCodexAdmin(app, oidcConfig, codexStore);

  // The Khronoton organ (scheduled autonomous signing): the ancient-gated cronoton
  // admin surface, sharing the same engine context (db + sealed-codex resolver +
  // chain runtime) as the tick loop. Keyed automaton core — never on the client path.
  registerKhronotonAdmin(app, oidcConfig, codexStore);
  // Ancient-gated dual-link DEACTIVATION ("API Break") → fires the dual-link-break
  // cronoton (on-chain A_RevokeLink). Same gate+confirm+audit as force-delete.
  registerConnectorBreak(app, { cfg: oidcConfig, codex: codexStore, pendingBreak: pendingBreakTracker });
}

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
