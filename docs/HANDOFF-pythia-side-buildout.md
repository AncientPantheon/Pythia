# HANDOFF — Pythia-side buildout: AncientHub node-pool + reward integration

**Direction:** AncientHub (hub) → Pythia. The **hub side is built and deployed**; this document tells the **Pythia agent** what to build in *this* repo to consume it.
**Status of the hub:** live at `https://ancientholdings.eu`. Both endpoints, the HMAC auth, the admin controls (secret rotation, IP allowlist, reward arm flag, economics), and the audit trail are shipped.
**Status of Pythia:** **no consumer exists yet.** Pythia today is a keyless two-host gateway (static `node1`/`node2`), an OIDC "Login with AncientHub" admin, and a keyless stats layer. Everything below is net-new or a modification of those.
**Companion doc:** the original spec (Pythia→hub) is `docs/HANDOFF-ancienthub-pythia-nodepool.md`. This doc supersedes its "Pythia will wire…" future-tense sections with the concrete build.

> **One-line summary:** build two lanes — (A) **reads** fan out across a *dynamic, hub-fed* node pool and are *metered back to the hub*; (B) **signed transactions** go *only* to a *manually-managed, ancient-gated* list of dedicated sender nodes and are *never metered*. All new config is gated by the existing ancient OIDC login.

---

## 1. Architecture — two lanes + hub-computed rewards

```
                         ┌──────────────────────── AncientHub (ancientholdings.eu) ───────────────────────┐
                         │  POST /api/pythia/nodes/   → { slots[], refreshAfter }   (usable read nodes)    │
                         │  POST /api/pythia/usage/   ← per-window per-slot {keyed,anon,ok}  (you report)  │
                         │  rewards (PythXP → level → Stoicism) computed HUB-SIDE from your usage reports   │
                         └──────────────▲───────────────────────────────────▲────────────────────────────┘
                                        │ poll ~60s (HMAC)                    │ push ~60s (HMAC)
   ┌──────────── Pythia (this repo) ────┼─────────────────────────────────────┼───────────────────────────┐
   │  LANE A — READS                     │                                     │                            │
   │   client → /stoachain/{read,poll} → NodePool (hub slots + seed fallback) → dial() → node → response    │
   │                                     └─ meter per served slot: keyed vs anon vs ok  ───────────────────►│
   │                                                                                                        │
   │  LANE B — TRANSACTIONS (NEVER metered as usage)                                                        │
   │   client → /stoachain/send → TxSenderStore (manual, ancient-managed dedicated senders ONLY) → node     │
   └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Lane A (reads):** every participating node the hub advertises serves read RPC. Pythia polls the feed, load-spreads reads across the healthy slots, and falls back to its seed nodes if the feed is empty/unreachable.
- **Lane B (transactions):** a **separate, manually-curated** list of dedicated transaction-sender nodes, editable *only* via the ancient admin UI. Signed `/send` traffic goes **exclusively** here — predictable tx delivery. These are **not** hub-fed and **not** reported as usage.
- **Rewards:** the hub computes **PythXP → PythLevel → Stoicism** from your read-usage reports using formulas that live **entirely hub-side**. **Pythia does not compute rewards** — it only reports accurate usage. (Displaying rewards on the Pythia side is optional — see §4.6.)

---

## 2. The hub API contract (authoritative — build against this)

Both endpoints live under `${HUB}` (production `https://ancientholdings.eu`), are **`POST`-only**, **folder routes with a trailing slash** (`/api/pythia/nodes/`, `/api/pythia/usage/`), and authenticate with **one shared HMAC secret** carried **in the request body** (there are **no** auth headers). Any other method → `405 Allow: POST`.

> ⚠️ **The M2M credential is a dedicated HMAC secret, NOT the OIDC client_credentials grant and NOT a header.** Do **not** reuse the `PYTHIA_OIDC_CLIENT_ID/_SECRET` (those are for the *human* login only). The hub provisions a separate 64-hex secret via its `/hub/pythia-admin` "Pythia service secret" control; the owner hands it to you out of band.

> ⚠️ **Egress IP allowlist.** The hub allowlists Pythia's egress IP (**`82.165.48.252`**). Your calls must originate from that IP or you get `403 { reason: "ip_not_allowed" }`. If Pythia's egress changes, the owner updates the allowlist on the hub.

### 2.1 The signed envelope (both endpoints)

Every request **body** is:

```jsonc
{
  "signature": "<hex HMAC-SHA256>",   // proves origin
  "nonce":     "<single-use random>", // e.g. crypto.randomUUID(); replay-rejected
  "timestamp": "<ISO-8601>",          // must be within ±300s of hub time
  "payload":   { /* endpoint-specific; may be {} for the feed */ }
}
```

**Signing algorithm (get this exact):**
1. Build the object `{ nonce, payload, timestamp }`.
2. **Canonicalize** it to JSON with **keys sorted at every depth** (a deterministic stringify — same bytes both sides).
3. `signature = HMAC_SHA256(sharedSecret, canonicalBytes)` **hex-encoded, lowercase**.
4. `nonce` must be unique per request; `timestamp` must be current (NTP-sync your clock — ±300s hard window, both directions).

```ts
// reference (Node)
import { createHmac, randomUUID } from "node:crypto";
function canonical(o){ // sort keys at every depth
  if (Array.isArray(o)) return `[${o.map(canonical).join(",")}]`;
  if (o && typeof o === "object")
    return `{${Object.keys(o).sort().map(k=>JSON.stringify(k)+":"+canonical(o[k])).join(",")}}`;
  return JSON.stringify(o);
}
function signEnvelope(payload, secret){
  const nonce = randomUUID(), timestamp = new Date().toISOString();
  const signature = createHmac("sha256", secret)
    .update(canonical({ nonce, payload, timestamp })).digest("hex");
  return { signature, nonce, timestamp, payload };
}
```

**Rejection codes (both endpoints):**
| Status | Body | Meaning |
|---|---|---|
| `503` | `{ error: "Pythia service is not configured" }` | hub secret unset (fail-closed) |
| `403` | `{ ok:false, reason:"ip_not_allowed" }` | your egress IP isn't allowlisted |
| `400` | `{ ok:false, reason:"invalid_shape" }` | envelope malformed (pre-auth) |
| `401` | `{ ok:false, reason:"bad_signature" \| "stale_timestamp" \| "future_timestamp" \| "replayed_nonce" }` | HMAC/freshness/replay fail |
| `429` | (Retry-After header) | rate-limited (120 req / 60s **per endpoint**) |

### 2.2 Endpoint A — `POST /api/pythia/nodes/` (the read-node feed, POST-to-read)

Request payload may be empty (`{}`). Success `200`:

```jsonc
{
  "slots": [
    {
      "id":        "203.0.113.5",              // BARE public IP — the join key; echo it VERBATIM in usage
      "url":       "https://203.0.113.5:1848", // route reads DIRECTLY here (public IP + host port, TLS)
      "networkId": "stoa",
      "operator":  "k:1a2b…",                  // owner account, or null (usable-but-unearning) — snapshot only
      "atTip":     true,                       // reachable && !lagging (only usable slots are listed)
      "height":    4210037
    }
  ],
  "refreshAfter": 60                            // seconds — re-poll no faster than this
}
```

- **Poll cadence:** every `refreshAfter` seconds (60). The list is only guaranteed fresh for that window.
- **`slot.url`** points directly at the node's public IP + host-published port over TLS — route reads there, **not** through the hub.
- **`slot.id`** is a bare IP (no `ip:` prefix). You **must** echo it byte-identically in the usage report — it's the reward-attribution join key.
- **Staleness caveat (hub-side, ~50–110s):** the hub's usability verdict is only as fresh as its ~30s tip cache, so a node that just died can linger in the feed for up to ~50s. **Keep your own client-side health check on each returned node and fall back to seeds on failure** — don't trust the feed as strongly-consistent.

### 2.3 Endpoint B — `POST /api/pythia/usage/` (the read-usage meter — money path)

Payload is a `PythiaUsageReport`:

```jsonc
{
  "period": { "from": "2026-07-10T12:00:00Z", "to": "2026-07-10T12:01:00Z" },  // ISO-8601 window
  "slots": [
    {
      "id":            "203.0.113.5",  // bare IP, echoed EXACTLY as received from the feed
      "operator":      "k:1a2b…",      // echo the feed's snapshot (or null) — provenance only
      "keyedRequests": 4300,           // reads from a registered connector key (ONLY these earn)
      "anonRequests":  120,            // anonymous reads (metered, never earn)
      "ok":            4290            // COUNT of successful reads (NOT a 0/1 flag)
    }
  ]
}
```

- Success `200`: `{ ok:true, inserted:[…], duplicate:[…] }`.
- **Idempotent per `(period, slot)`, first-write-wins.** A retry with the same window+slot is deduped (safe), but a **re-send must carry byte-identical counts** — never a correction. A corrected count must be a **new, non-overlapping** window.
- **Window contract you MUST honor:** windows are **non-overlapping, contiguous, and immutable once reported**. The hub does no overlap math — two overlapping windows both store and **over-attribute earnings**.
- An **empty `slots` array is a valid** zero-usage report. A slot id may not appear twice in one report.
- **`ok` is a success COUNT**, not a boolean.

---

## 3. Current Pythia state (verified against this repo)

| Subsystem | Today | Relevant files |
|---|---|---|
| **Read routing** | Static **two-host** dial: `order=[primary,fallback]`, sequential, transport-failover-once, 10s timeout; **`extras` is accepted but never dialled** ("two-host only"). All reads/sends funnel through **`resolveSources()`** → `loadConfigFromDisk()` → `find(role)`. Config re-read from disk **every request**. | `dial/dial.ts`, `routes/relay.ts:28-37`, `config/loader.ts`, `config/pythia.config.json`, `config/types.ts` |
| **Node config** | `SourceConfig = {id,url,role:'primary'\|'fallback',chain}`; **hard invariant: exactly 1 primary + 1 fallback** (`loader.ts:84-93`) — this structurally forbids an N-node pool. | `config/loader.ts`, `config/types.ts` |
| **Health** | `startHealthPoller` (15s) **exists but is never started**; health is display-only (`/healthz`), decoupled from the dial. | `health/resolver.ts`, `routes/healthz.ts` |
| **OIDC admin** | Full **auth-code + PKCE + confidential exchange**, RS256 id_token verify, 8h session cookie. **Role comes from the ID token `roles` claim**; `ANCIENT_ROLE="ancient"`, `hasAncientRole()`. The ancient gate **`createAdminGate(cfg)`** already guards the **Connectors** CRUD. Admin SPA is `public/index.html` + `public/app.js` with an ancient-aware **Connectors tab**. | `admin/routes.ts`, `admin/idToken.ts`, `admin/session.ts`, `admin/discovery.ts`, `public/index.html`, `public/app.js` |
| **Persistence pattern** | `connectors/store.ts` = file-backed, load-on-construct, **atomic temp+rename** JSON on the mounted volume. **Model every new store on this.** | `connectors/store.ts` |
| **Tx send** | `/stoachain/send` forwards `{cmds}` verbatim (keyless) via the **same** `resolveSources()` primary/fallback as reads. **No dedicated-sender concept.** | `routes/send.ts`, `routes/relay.ts` |
| **Stats/usage** | Keyless in-memory **day-granular monotonic** aggregate (`day\|consumer\|chain\|endpoint\|ok`); flushes to `pythia-stats.json` every 30s. **Keyed-vs-anon is already known**: `resolveConsumer(x-pythia-key) !== "direct"` ⇒ keyed. **⚠️ It currently counts `read`+`send`+`poll` — `send` IS counted.** No per-node/slot dimension, no windowing, no reporter. | `stats/middleware.ts`, `stats/store.ts`, `stats/consumers.ts`, `connectors/store.ts` |

---

## 4. Components to build

### 4.1 HMAC service client `(src/hub/serviceClient.ts — new)`
- Implements the §2.1 signed envelope + POST to the hub.
- Config: **hub base URL** + **shared HMAC secret** (from deploy env/settings — see §6; **not** the OIDC secret).
- Two methods: `fetchNodes()` → `{slots, refreshAfter}`; `postUsage(report)` → `{ok, inserted, duplicate}`.
- Handle all §2.1 rejection codes; log + back off on `401/403/503`, respect `429 Retry-After`.

### 4.2 Hub node-pool consumer — the read lane
The read lane's single choke point is **`resolveSources()` (`routes/relay.ts:28-37`)**; every read (`read.ts:102`, `poll.ts:73`) and send (`send.ts`) calls it. Rework:

1. **`src/pool/nodePool.ts` (new):** an in-memory, refreshable holder. A **~60s poller** (model on `health/resolver.ts:118` `startHealthPoller`, currently unmounted) calls `serviceClient.fetchNodes()` and caches the usable slots. On empty/unreachable feed → serve the **checked-in `config.sources` as SEED fallback**. Start it at boot in `src/index.ts` (after route registration ~L87).
2. **Generalize `dial()`:** replace `DialDeps.{primary,fallback,extras}` + `order=[primary,fallback]` (`dial.ts:96`) with an **ordered `nodes: SourceConfig[]`** (hub slots first, seeds last). Keep the failover semantics (`isTransportFailure`, 10s timeout, `PythiaPoolExhaustedError`). Add a **rotating/shuffled start index** so reads spread across healthy slots (not always the first).
3. **Rework `resolveSources()`** to return the live pool (hub slots + seed tail) from `nodePool`, instead of `find(role)`. Update the 3 callers' `DialDeps` destructuring in lockstep. Keep `loadConfigFromDisk()` for the **seed list + `finalityDepth`/`readGasLimit`/`corsOrigins`** only.
4. **Relax the config invariant:** `loader.ts:84-93` (exactly 1 primary + 1 fallback) — reinterpret the checked-in `sources` as the **seed tier** (an N-legal list is fine), or add a `tier: 'seed'|'hub'` field to `SourceConfig`.
5. **Surface the served slot id** out of `dial()` (today it returns a bare `Response` and discards which node served) so the meter (§4.3) can attribute per-slot. Stash it on the request context (e.g. `c.set('servedSlotId', node.id)`).

### 4.3 Per-slot usage meter + reporter — the money path
1. **`src/stats/slotUsage.ts` (new):** a **windowed** meter — `Map<slotId, {keyedRequests, anonRequests, ok}>` + a window-start timestamp. `drain()` returns `{ period:{from,to}, slots:[…] }` and **resets** the window. (The existing `StatsStore` is day-granular + monotonic — wrong shape; leave it for `/stats`.)
2. **Metering middleware:** in a sibling to `stats/middleware.ts`, **after `next()`**, **only when `endpoint === 'read'` AND a `servedSlotId` is set** (i.e. it hit a hub-pool node), record `{ slotId, keyed: resolveConsumer(key)!=='direct', ok: res.status<400 }`. **Do not meter `send` or `poll`; do not meter seed-node reads** (only hub-pool slots earn).
3. **`src/stats/usageReporter.ts` (new):** a **~60s timer** (model on the `StatsStore` flush timer or `startHealthPoller`) that `drain()`s the meter, joins each `slotId → operator` from the last feed snapshot, and `serviceClient.postUsage()`s the report. **Honor the window contract** (§2.3): contiguous non-overlapping windows, immutable once sent; on a transient POST failure, **retry the same window with identical counts** (idempotent) rather than merging into the next. Start it at boot.

### 4.4 Dedicated tx-sender lane (manual, ancient-gated)
1. **`src/txsenders/store.ts` (new):** file-backed, atomic temp+rename, in-memory array of `{ id, url, label, enabled, addedAt }`. **Model exactly on `connectors/store.ts`.** Persist to a new `TXSENDERS_FILE` on the mounted volume. Instantiate in `src/index.ts` alongside `connectorStore`.
2. **Ancient-gated CRUD:** in `admin/routes.ts` `registerAdmin`, add `GET/POST /admin/tx-senders` + `DELETE /admin/tx-senders/:id`, **reusing `createAdminGate(cfg)`** (mirror the connector routes at `routes.ts:253-278`).
3. **Route `/send` to the tx-senders ONLY:** in `routes/send.ts`, replace the `resolveSources()` call (`send.ts:71`) with resolution from `TxSenderStore` (dial across the enabled senders; generalize `dial()` per §4.2 or wrap two at a time).
4. **⚠️ Empty-list guard:** if the tx-sender store is empty/all-disabled, **return an explicit `503 no tx-sender configured`** — **never** fall back to read/seed nodes. Predictable tx delivery is the whole point.
5. **⚠️ Exclude sends from usage:** in `stats/middleware.ts`, **remove `send` from `OPERATIONAL_PATH`** (`middleware.ts:11`) — or route it to a separate non-read bucket — so a signed tx is **never** metered as a read. (This is load-bearing: the hub reward-meter earns on `keyedRequests`; if sends leak in, operators get over-credited for tx-serving, which the owner explicitly does **not** want.)

### 4.5 Ancient-gated admin config surface
Extend the existing OIDC-gated admin (all reusing `createAdminGate(cfg)`):
- **New settings store** `src/admin/settingsStore.ts` (model on `connectors/store.ts`) for the mutable values below.
- **Server routes** in `admin/routes.ts`: `GET/POST /admin/config`.
- **SPA tab** in `public/index.html` (add a `data-tab` button + a `data-panel` section mirroring Connectors) + loader in `public/app.js`, visible only when `isAncient()`.
- **Controls to expose:**
  - **Hub base URL** (or read-only if you keep it env-driven).
  - **Shared HMAC service secret** (write-only input; store hashed/sealed if practical — it's a bearer credential).
  - **Poll cadence** (feed poll + usage-report interval).
  - **Tx-sender node list** (the §4.4 CRUD).
  - **(Optional) read-only economy display** (§4.6).

### 4.6 (Optional) read-only economy display
The economy (PythXP → level → Stoicism) is **hub-computed and hub-displayed** (owner sets the formulas hub-side; the hub UI shows them). If you want Pythia operators to see their standing on the Pythia side too, add a **read-only proxy**: `GET /admin/economy` (ancient-gated) that calls a hub read endpoint and renders it. **This is optional and depends on the owner exposing a hub economy endpoint (TBD).** Do not build an economy *setter* here — the hub owns it.

---

## 5. Correctness pins (do not skip — most are load-bearing)

1. **HMAC secret ≠ OIDC creds.** The M2M auth is the dedicated shared HMAC secret (body envelope), provisioned on the hub's `/hub/pythia-admin`. The OIDC client is *only* for human login.
2. **Echo `slot.id` byte-identically** from feed → usage report. It's the reward join key; a mismatch attributes to no slot and under-pays operators.
3. **Only KEYED READS on HUB-POOL slots earn.** Meter `endpoint==='read'` + `servedSlotId` set + `keyed = consumer!=='direct'`. Exclude sends, polls, seed-node reads.
4. **Sends are never usage** (§4.4.5) — remove `send` from the stats path before the tx split.
5. **Window contract** (§2.3): contiguous, non-overlapping, immutable; retries carry identical counts.
6. **Empty tx-sender list fails closed** (§4.4.4) — never route signed tx to read/seed nodes.
7. **Client-side health + seed fallback** (§2.2) — the feed is eventually-consistent (~50–110s worst case); don't trust it as strongly-consistent.
8. **Calls must egress from `82.165.48.252`** (the allowlisted IP) or the hub returns 403.

---

## 6. Config & secrets
- **`HUB_BASE_URL`** — `https://ancientholdings.eu` (or an admin-settings override).
- **`PYTHIA_HUB_HMAC_SECRET`** — the 64-hex M2M secret; the hub owner generates it via `/hub/pythia-admin` → "Pythia service secret" → *Generate & rotate* and hands it to you **out of band**. Store as a deploy secret (env) and/or the sealed settings store — **never commit it**. Rotating on the hub invalidates the old value; you must be reconfigured.
- **`TXSENDERS_FILE`** — path on the mounted volume for the tx-sender store (mirror `CONNECTORS_FILE`).
- Existing `PYTHIA_OIDC_*` + `PYTHIA_SESSION_SECRET` are unchanged (human login).

---

## 7. Acceptance criteria
1. On boot, Pythia polls `POST /api/pythia/nodes/` (signed) every ~60s and holds the usable slots in memory; reads fan out across them; an empty/unreachable feed falls back to the seed nodes.
2. Reads route to `slot.url` directly; a per-read tick records `{slotId, keyed|anon, ok}` **only** for hub-pool read requests.
3. Every ~60s Pythia POSTs a signed `PythiaUsageReport` for a contiguous, non-overlapping window; the hub returns `{ok:true, inserted:[…]}`; a forced retry of the same window is deduped (`duplicate:[…]`).
4. `/stoachain/send` routes **only** to the ancient-managed tx-sender list; an empty list returns `503`; sends never appear in any usage report.
5. An ancient admin can, in the Pythia SPA: set the hub URL + HMAC secret + poll cadence, and add/remove tx-sender nodes; a non-ancient session cannot see or call these.
6. A wrong/rotated secret, an off-window clock, or a non-allowlisted egress produces the documented `401/403/503` and is logged (not a silent stall).

---

## 8. Open coordination items (with the hub owner)
- **Secret exchange:** owner generates the HMAC secret on the hub and sends it to you; you configure `PYTHIA_HUB_HMAC_SECRET`.
- **Egress IP:** confirmed `82.165.48.252` is allowlisted on the hub. If Pythia's egress changes, tell the owner to update `/hub/pythia-admin` → IP allowlist.
- **Economy formulas:** the PythXP level-threshold formula and the Stoicism-per-level formula are being finalized by the owner and implemented **hub-side**; if you want a Pythia-side read-only display (§4.6), the hub will need to expose an economy read endpoint (TBD).
- **First light:** after both sides deploy, the pool should *enlarge in Pythia* as the hub advertises usable slots. Verify with the hub owner (the hub can independently confirm the feed returns slots for `82.165.48.252`).

---
*Generated from a live map of this repo + the deployed hub contract. Contract source of truth: the hub's `/docs/hub/pythia-integration` page and `pages/api/pythia/{nodes,usage}/index.ts`.*
