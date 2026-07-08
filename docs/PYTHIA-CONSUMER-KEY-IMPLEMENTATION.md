# Pythia consumer-key model — PYTHIA-SIDE implementation spec

> **WARNING: cross-component interfaces are SETTLED in [HANDOFF-consumer-key-INTERFACES.md](HANDOFF-consumer-key-INTERFACES.md).** Where naming or any inter-component contract in this doc differs from that ICD - module/read names, the paid field, the redirect-sign return leg, the verifier->Cronoton HMAC envelope, or the activation cap/keyset - **the ICD wins.**

**Status:** implementation handoff (2026-07-08). Maps the settled model in
[`docs/PYTHIA-CONSUMER-KEY-MODEL.md`](./PYTHIA-CONSUMER-KEY-MODEL.md) onto the **real
files** in this repo. It is the buildable companion to §7 ("Pythia") of the canonical
spec. Read the canonical spec first — this document does not restate the model, it
wires it.

Scope: **only the Pythia read-engine side**. The on-chain Pact module, the Automaton,
OuronetUI, and the Codex are separate handoffs. This spec never signs a chain tx,
never holds a key, and never touches the 250 STOA payment — Pythia stays **keyless +
fund-less** (canonical §5.2, §5.5).

The whole lane sits behind one env flag (`PYTHIA_CRYPTO_LANE`, default off) so it
boots dark and rolls back to the existing shared-secret `ConnectorStore` instantly.

---

## 0. Grounding — the seams as they exist today

| Seam | File | What it does now | What this spec adds |
|------|------|------------------|---------------------|
| Consumer resolution | `apps/pythia/src/index.ts` `resolveConsumer()` (L57–65) | store → env → `"direct"` | a NEW **first** branch: presented Apollo public key → activated in mirror → its lane |
| Usage metering | `apps/pythia/src/stats/middleware.ts` | reads `x-pythia-key`, calls `resolveConsumer` | unchanged — it already takes the resolver as an injected fn |
| Legacy attribution | `apps/pythia/src/connectors/store.ts`, `src/stats/consumers.ts` | shared-secret hash + env map | untouched — the crypto lane is a THIRD coexisting lane |
| Keyless read builder | `apps/pythia/src/chainweb/localCommand.ts` `buildLocalCommand()` | `{cmd,hash,sigs:[]}` `/local` envelope, `signers:[]` | reused verbatim to read the on-chain registry |
| Read dispatch | `apps/pythia/src/routes/read.ts` (`dial` + `localReadPath`) | relays a `/local` body over the failover dial | the mirror poller reuses this exact dispatch pattern internally |
| Admin/redirect patterns | `apps/pythia/src/admin/routes.ts` | OIDC login: mint state/nonce → cookie → redirect → verify | the activation challenge reuses the mint-nonce → redirect → verify shape |
| Keyless invariant | `apps/pythia/src/invariants/keylessScanner.ts` | bans broadcast/signing symbols + write modules | add Apollo `sign`/`generateFrom*` to the banlist |

The canonical facts this wiring must preserve:

- A Pythia API key = an Apollo Account's `₱./Π.` public key (canonical §1).
- Pythia READS the on-chain registry via a **dirty `/local` read** and CACHES it —
  it is not the source of truth (canonical §6).
- Reads are **cached + fail-OPEN**: chain unreachable → serve the last-good activated
  set (bounded max-stale) and degrade to the shared-secret / community lane (canonical
  §5.4). This reuses the SAME degrade-to-seed instinct already in the codebase: every
  loader in this repo (`loadConsumerMap`, `ConnectorStore.load`, `loadConfigFromDisk`
  fallbacks) fails toward "serve, attribute to direct" rather than crash.

---

## 1. On-chain registry MIRROR — cached, fail-open `/local` read

**New files:** `apps/pythia/src/registry/mirror.ts`, `apps/pythia/src/registry/read.ts`.

### 1.1 What it reads

The mirror polls the on-chain accessors sketched in canonical §6, over the KEYLESS
`buildLocalCommand` path:

```
(UR_ListPythiaKeys)   -> [ { apollo-public, consumer-lane, activated, owner-account,
                             origins, registered-at, updated-at }, ... ]
```

One list read per poll is enough: Pythia is a read engine that also serves the public
directory (§3), so it wants ALL rows (active or not), not just the activated set. The
per-key `UR_PythiaKeyActivated` / `UR_PythiaKeyRow` accessors are NOT called on the hot
path — the mirror is consulted in-memory.

> **RESOLVE-FIRST (carried from canonical §6):** confirm the deployed module's real
> defun names + the exact `₱./Π.` Apollo string encoding before wiring. If
> `UR_ListPythiaKeys` is not deployed, fall back to reading a known-index table or a
> published enumeration accessor — the mirror only needs "give me all rows".

### 1.2 The read (reuse the existing dispatch)

`registry/read.ts` builds the `/local` body with the **existing** builder and dispatches
over the **existing** dial — no new network surface, no new keyless risk:

```ts
// registry/read.ts  (sketch — reuses src/chainweb/localCommand.ts + src/dial)
import { buildLocalCommand } from "../chainweb/localCommand.js";
import { dial, STOA_NETWORK } from "../dial/index.js";

const REGISTRY_CHAIN = Number(process.env.PYTHIA_REGISTRY_CHAIN ?? "0");
const REGISTRY_CODE = "(free.pythia-keys.UR_ListPythiaKeys)"; // RESOLVE exact ns/module

export async function readRegistryRows(deps): Promise<RegistryRow[]> {
  const body = buildLocalCommand(REGISTRY_CODE, { chainId: REGISTRY_CHAIN });
  const response = await dial(
    { chainId: REGISTRY_CHAIN, buildRequest: (host) => [
        `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${REGISTRY_CHAIN}/pact/api/v1/local`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
      ] },
    { primary: deps.primary, fallback: deps.fallback, fetchImpl: deps.fetchImpl },
  );
  const json = await response.json();
  if (json?.result?.status !== "success") throw new RegistryReadError(json);
  return normalizeRows(json.result.data); // validate shape defensively
}
```

Keep `localReadPath` DRY: either import it from `routes/read.ts` (export it) or inline
the one-liner. Prefer exporting `localReadPath` from a small shared module so both the
route and the mirror share it.

### 1.3 The cache + fail-open policy

`registry/mirror.ts` is a single in-process object (same shape as `ConnectorStore` —
in-memory array is truth, single process):

```ts
interface MirrorState {
  rows: RegistryRow[];          // last GOOD full snapshot (all rows, any activated)
  activated: Map<string,Row>;   // apollo-public -> row, filtered activated===true
  fetchedAt: number;            // epoch ms of last SUCCESSFUL read
  lastError?: string;           // last poll failure, for /healthz + directory meta
}
```

- **Poll interval:** `PYTHIA_REGISTRY_POLL_MS`, default `60_000` (canonical §7 "~60s").
- **Max-stale bound:** `PYTHIA_REGISTRY_MAX_STALE_MS`, default `600_000` (10 min).
  If `now - fetchedAt <= maxStale` the activated set is served normally.
- **Fail-open on unreachable chain (canonical §5.4):** a failed poll does NOT clear
  `rows`/`activated`. It only sets `lastError` and leaves the last-good snapshot in
  place. The grant branch keeps honoring the last-good activated set until max-stale.
- **Degrade past max-stale:** once `now - fetchedAt > maxStale`, the mirror is
  considered **cold**. The grant branch treats a cold mirror as "no crypto match" and
  **falls through to the shared-secret store → env → direct** (§2). This is the exact
  degrade-to-seed rule already used everywhere in this repo: never fail the read, drop
  to the community lane. A cold mirror never 500s a `/stoachain/read`.
- **Boot:** first poll fires immediately on startup (only when the lane is enabled);
  until it completes, the mirror is cold → everything falls through to the store. No
  request path ever awaits a poll.
- **Instant revocation override (canonical §3d):** a local denylist
  (`PYTHIA_KEY_DENYLIST`, comma-separated apollo-publics, or a small file) is subtracted
  from `activated` on every lookup, so an operator can kill a lane before the on-chain
  flip + finality + next poll lands.

The poller is a bare `setInterval` started from the app bootstrap (next to where
`statsStore` is constructed in `index.ts`), guarded by the env flag, and cleared on
shutdown alongside the existing stats flush.

---

## 2. The grant/attribution branch — FIRST in `resolveConsumer`

**File:** `apps/pythia/src/index.ts` — extend `resolveConsumer()` (L57–65).

Today the resolver takes only the raw key string. The crypto lane keys off the **same**
`x-pythia-key` header the middleware already passes (the Codex forwards the baked Apollo
public key in that header — canonical §7 Codex). So the presented header value is EITHER
a legacy `pk_live_…` secret OR an Apollo public key; the resolver tries the crypto lane
first, then falls through unchanged.

```ts
// index.ts — mirror constructed near statsStore/connectorStore, behind the flag.
import { RegistryMirror } from "./registry/mirror.js";
const cryptoLaneOn = process.env.PYTHIA_CRYPTO_LANE === "1";
const mirror = cryptoLaneOn ? new RegistryMirror(/* dial deps */) : undefined;

function resolveConsumer(key?: string): string {
  if (key) {
    // 1. CRYPTO LANE (first): presented value is an activated Apollo public key.
    //    Fail-open: a cold/unreachable mirror returns undefined → fall through.
    const lane = mirror?.laneForActivatedKey(key);
    if (lane) return lane;
    // 2. shared-secret connector store (unchanged)
    const fromStore = connectorStore.nameForKey(key);
    if (fromStore) return fromStore;
    // 3. env map (unchanged)
    const fromEnv = envConsumerMap.get(key);
    if (fromEnv) return fromEnv;
  }
  return "direct";
}
```

`mirror.laneForActivatedKey(key)` = `activated.get(key)?.consumerLane` **after** the
denylist subtraction and the max-stale check, else `undefined`. When the flag is off,
`mirror` is `undefined` and the resolver is byte-for-byte its current behavior.

### 2.1 Grant is not just attribution — it is the access gate

`resolveConsumer` currently only labels usage. In the crypto model, an **activated**
key also confers "read + relay-of-signed-tx" grant (canonical §3c). Two ways to wire it,
pick per rollout posture:

- **Attribution-only first (recommended P3):** the crypto branch only sets the lane
  label; access stays open exactly as today (the gateway is already a public keyless
  read engine). This ships the identity + directory without changing who can call.
- **Gated (later):** if/when Pythia enforces "only activated keys may relay", add a
  separate `mirror.isActivated(key)` check in the `/stoachain/*` route guards — NOT in
  `resolveConsumer` (keep resolution pure/label-only; do enforcement in the route).
  Enforcement must ALSO fail-open past max-stale (cold mirror → serve, per §1.3), so a
  chain outage never locks out the whole gateway.

Do not overload `resolveConsumer` with enforcement — it returns a label and the stats
middleware depends on that contract.

---

## 3. Public directory + activated-count endpoint

**New file:** `apps/pythia/src/routes/registry.ts`; registered in `index.ts` before the
static catch-all (same slot as `registerStats`).

Pythia is a **read engine**, so it publishes ALL registered keys, active or not
(canonical §7 "shows them all regardless of the switch"). This mirrors the read-only,
no-auth posture of `GET /stats` and `GET /api/v1/connectors`.

```
GET /api/v1/registry            -> { keys: [ { apolloPublic, consumerLane, activated,
                                               ownerAccount, origins, registeredAt,
                                               updatedAt } ], meta: {...} }
GET /api/v1/registry/count      -> { total, activated, inactive, fresh, fetchedAt }
```

- Source: the mirror's last-good `rows` (never triggers a live chain read on request —
  same "poll in background, serve from memory" pattern as the stats store).
- `meta` / `count` expose freshness so callers can see staleness:
  `{ fetchedAt, ageMs, stale: ageMs > maxStale, lastError }`.
- **Never leaks secrets:** the registry rows are public on-chain data (public keys,
  lanes, owner accounts). This is the crypto-lane analog of `ConnectorStore.publicList()`
  — but here EVERY row is public because there is no secret in it (keyless model).
- When the lane is off (`mirror === undefined`), the routes return `{ keys: [], meta:
  { enabled: false } }` (200) rather than 404 — the endpoint exists but reports the lane
  is dark. Do NOT register it at all if you prefer a hard 404 when disabled; either is
  fine, but be consistent with how `/admin/*` is conditionally wired.

The landing page (`public/`) can later add a "Registered API keys" tab reading
`/api/v1/registry`, parallel to the existing Connectors tab — out of scope here.

---

## 4. Activation verifier + Cronoton trigger — **OPEN: Pythia vs hub**

> **This is the one deliberate design decision left open (canonical §8).** Build the
> mirror + grant + directory (§1–§3) FIRST; they are needed under BOTH answers. Only
> build §4 if the decision lands on **Pythia hosts the verifier**. The canonical spec
> leans slightly toward the **hub** owning the write-path for clean separation. Flag
> this at the top of the P4 PR.

If Pythia hosts the verifier, it needs net-new challenge state and a Dalos verify call.
The shape reuses the admin redirect-sign pattern already in `admin/routes.ts` (mint
state/nonce → cookie/redirect → verify on return).

### 4.1 Challenge store (net-new state)

**New file:** `apps/pythia/src/activation/challenges.ts` — an in-memory single-use,
short-TTL nonce store (same in-process-map discipline as everything else here):

```ts
interface Challenge { nonce: string; apolloPublic: string; expiresAt: number; }
// mint(apolloPublic) -> nonce (crypto.randomBytes, base64url); TTL ~120s
// consume(nonce): returns+deletes the challenge iff present AND unexpired (single-use)
// a sweeper (setInterval) evicts expired entries
```

### 4.2 The endpoints

```
GET  /activate/challenge?apolloPublic=<₱./Π.>
     -> { nonce, redirectUrl }   // redirectUrl = OuronetUI/Codex sign-and-return URL
POST /activate/verify
     body { apolloPublic, nonce, signature }
     -> { ok } | { error }
```

`GET /activate/challenge` mirrors `GET /admin/login`: mint a fresh single-use nonce,
store it, hand back the OuronetUI redirect (the SEED lives there; canonical §3b step 3).
Pythia never receives a seed — only `{apolloPublic, signature}` come back (canonical
hard rule §5.1).

`POST /activate/verify` does, in order:

1. `challenges.consume(nonce)` — must exist, be unexpired, and match `apolloPublic`.
2. `apolloPublic` must be present in the mirror's `rows` (registered on-chain) — reuse
   §1 mirror, do not re-read the chain inline.
3. **`Apollo.verify(signature, nonce, apolloPublic)`** — pure public-data verification
   using Dalos (`@stoachain/dalos-crypto`). This is Node-side, keyless, no key material.
4. On success: fire the **authenticated instruct-Cronoton trigger** (canonical §5.3):
   an outbound authenticated call telling the HUB Codex Cronoton to submit `TurnApiOn`
   / `A_ActivatePythiaKey(apolloPublic)`. Pythia does NOT sign the chain tx — it only
   sends an authenticated instruction over a shared-secret / mTLS channel to the hub.

**New file:** `apps/pythia/src/activation/cronoton.ts` — the authenticated outbound
trigger (a `fetch` to a hub endpoint with a bearer/HMAC from `PYTHIA_CRONOTON_TOKEN`).
This is the ONLY new outbound-to-hub surface; it carries no key material and cannot
move funds — it only requests an activation the hub still admin-caps.

### 4.3 Keyless boundary for the verifier

`Apollo.verify` is verification-only and MUST be the only Dalos symbol imported. Import
it via a **narrow local wrapper** (`apps/pythia/src/activation/apolloVerify.ts`) that
re-exports ONLY `verify`, so the banlist scanner (§5) can assert nothing else from Dalos
leaks in. Never import the Dalos barrel.

---

## 5. Keyless hardening + env flag (boot-dark, instant rollback)

### 5.1 Extend the keyless scanner banlist

**File:** `apps/pythia/src/invariants/keylessScanner.ts`.

The scanner today bans broadcast/submit symbols (`BANNED_BROADCAST_SYMBOLS`) and
write-capable modules (`BANNED_IMPORT_MODULES`). Add Apollo signing/seed-derivation
symbols so signing can never be smuggled into Pythia's source (canonical §5.2):

```ts
export const BANNED_BROADCAST_SYMBOLS = [
  "submit", "listen", "pollOne", "createClient", "getFailoverClient",
  // Apollo signing / seed-derivation — Pythia verifies (public data) but NEVER
  // signs and NEVER derives a key from a seed. These must not appear in source.
  "sign", "generateFromSeedWords", "generateFromMnemonic", "generateKeyPair",
] as const;
```

Notes on scoping (the scanner is word-boundary based — see `bannedPattern`):

- `sign` will match a bare `sign(` call under the `\b…\b` boundary. Verify no legitimate
  identifier in Pythia's own source is named `sign` (there is none today —
  `signSession`/`signLoginState` in `admin/session.ts` are distinct identifiers and
  survive the word boundary since `signSession` ≠ `sign`). Confirm with a scan run in CI;
  if a false positive appears, prefer renaming Pythia's identifier over loosening the ban.
- Prefer also banning the **Dalos signing import surface** via `BANNED_IMPORT_MODULES`
  if Dalos exposes a submodule path for signing (e.g. a `@stoachain/dalos-crypto/sign`
  entry). Banning the import path is a stronger boundary than banning the symbol (the
  scanner's own comment says so). The verify-only wrapper (§4.3) keeps the allowed
  surface to exactly `verify`.
- The scanner excludes its own file (`SCANNER_FILENAME`), so enumerating the banned
  Apollo symbols here does not self-trip.

Wire the extended scan into the same CI/test step that already asserts
`scanForBannedSymbols` / `scanForBannedImports` return empty over `apps/pythia/src`.

### 5.2 One env flag gates the whole lane

`PYTHIA_CRYPTO_LANE` (default unset/`0` = OFF):

- OFF → `mirror` is `undefined`; `resolveConsumer` is byte-identical to today; the
  registry routes report `enabled:false` (or are unregistered); no poller runs; no
  activation routes; the gateway is exactly the current shared-secret build.
- ON → mirror poller starts, crypto branch active in `resolveConsumer`, registry routes
  live, (if §4 chosen) activation routes live.

Supporting env (all optional, sane defaults):

| Env | Default | Meaning |
|-----|---------|---------|
| `PYTHIA_CRYPTO_LANE` | `0` | master switch for the whole lane |
| `PYTHIA_REGISTRY_CHAIN` | `0` | chain the registry table lives on |
| `PYTHIA_REGISTRY_POLL_MS` | `60000` | mirror poll interval |
| `PYTHIA_REGISTRY_MAX_STALE_MS` | `600000` | fail-open ceiling before degrade-to-store |
| `PYTHIA_KEY_DENYLIST` | `""` | instant local revocation (apollo-publics) |
| `PYTHIA_CRONOTON_URL` / `PYTHIA_CRONOTON_TOKEN` | — | authenticated instruct-Cronoton channel (§4 only) |

Rollback is instant: unset `PYTHIA_CRYPTO_LANE`, redeploy — the store/env/direct lanes
are untouched and were never removed. This is the same "opt-in third lane, coexists"
posture as the canonical spec (§9 Resolved).

---

## 6. Build order (Pythia slice of canonical §10)

- **P2 — mirror** (§1): `registry/read.ts` + `registry/mirror.ts` + poller in `index.ts`.
  Fail-open + max-stale + denylist. No behavior change to callers (label plumbing only).
- **P3 — grant branch** (§2) + **public directory** (§3): the crypto-first branch in
  `resolveConsumer`, `routes/registry.ts`, both behind `PYTHIA_CRYPTO_LANE`. Keep it
  attribution-only first; add route-level enforcement later if desired.
- **Hardening (any time, do early):** §5.1 banlist extension + CI scan. Cheap, and it
  guards every later PR.
- **P4 — activation** (§4) **only if Pythia hosts the verifier** (OPEN, canonical §8):
  `activation/challenges.ts`, `activation/apolloVerify.ts`, `activation/cronoton.ts`,
  the two `/activate/*` routes.

---

## 7. Open questions (Pythia-scoped)

1. **Verifier location (canonical §8) — the headline open decision.** If the hub hosts
   it, §4 is dropped entirely and Pythia only reads the mirror + serves the directory.
   Decide before P4.
2. **Exact deployed accessor names + `₱./Π.` encoding** (canonical §6 RESOLVE-FIRST):
   confirm `UR_ListPythiaKeys` (and namespace/module) exists on the deployed module and
   returns the row shape assumed in §1.1; confirm the Apollo public-key string is the
   exact `Apollo.verify` input.
3. **Grant enforcement vs attribution-only:** does an activated key merely LABEL usage,
   or does it also gate `/stoachain/*` relay? (§2.1). If gated, confirm the fail-open
   semantics for a cold mirror are acceptable to governance (chain outage = open, not
   closed).
4. **Registry endpoint when disabled:** `enabled:false` 200 vs hard 404 (§3) — match
   whichever convention the landing page expects.
5. **Cronoton channel auth** (§4.2, if Pythia-hosted): bearer vs HMAC vs mTLS for
   `PYTHIA_CRONOTON_*`; the canonical hard rule §5.3 requires it be authenticated so a
   third party cannot request arbitrary activations.
6. **`Apollo.verify` round-trip proof** (canonical §9 Open): empirically confirm the
   Dalos `generateFromSeedWords → sign → verify` round trip against a real Apollo key
   BEFORE shipping §4 — the verifier is worthless if the encoding assumptions are wrong.
7. **`sign` word-boundary false positives** (§5.1): confirm the extended banlist scan is
   clean over `apps/pythia/src` in CI; resolve any hit by renaming Pythia's identifier,
   not by weakening the ban.

---

**Anchors:** canonical model `docs/PYTHIA-CONSUMER-KEY-MODEL.md`; real seams
`apps/pythia/src/index.ts` (`resolveConsumer`), `src/chainweb/localCommand.ts`
(`buildLocalCommand`), `src/dial/index.ts` (`dial`), `src/routes/read.ts` (dispatch
pattern), `src/connectors/store.ts` (in-process store discipline), `src/stats/middleware.ts`
(injected resolver contract), `src/admin/routes.ts` (mint-nonce→redirect→verify pattern),
`src/invariants/keylessScanner.ts` (banlist).
