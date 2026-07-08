# Handoff: Add Pythia-API-key activation to the AncientHoldings HUB Codex Cronoton engine

> **WARNING: cross-component interfaces are SETTLED in [HANDOFF-consumer-key-INTERFACES.md](HANDOFF-consumer-key-INTERFACES.md).** Where naming or any inter-component contract in this doc differs from that ICD - module/read names, the paid field, the redirect-sign return leg, the verifier->Cronoton HMAC envelope, or the activation cap/keyset - **the ICD wins.**

**From:** Pythia (`pythia.ancientholdings.eu`) — the keyless read/verify layer.
**To:** the agent that owns the **AncientHoldings HUB Codex Cronoton engine**
(`D:\_Claude\StoaOuronet\AncientHoldings`, `lib/codex-cronoton/*`, `worker/index.ts`).
**Status:** **spec-ready** — draft the hub spec from this. Nothing here is built yet.
**Canonical spec (read first):**
`D:\_Claude\AncientPantheon\Pythia\docs\PYTHIA-CONSUMER-KEY-MODEL.md`
**Companions:** `HANDOFF-ancienthub-pythia-nodepool.md` (the service-to-service
`/api/pythia/*` HMAC channel this handoff reuses), `HANDOFF-ancienthub-sso.md`
(the OIDC IdP + Ouronet redirect-and-sign handshake this reuses for ownership proof).

> **One-sentence job:** teach the Codex Cronoton — the hub's existing keyed
> tx-signing cron engine — to submit `TurnApiOn` / `TurnApiOff` against the new
> Pythia consumer-key Pact module, **only** when it receives an *authenticated,
> VERIFIED-OK* activation signal AND the 250-STOA Deploy payment is confirmed
> on-chain, with the same claim-before-fire idempotency the engine already uses.

---

## 0. Where this sits in the settled model (do not re-litigate)

From the canonical spec, the confirmed decisions this handoff must stay consistent with:

- A **Pythia API key = an on-chain Apollo Account** (its `₱./Π.` Apollo public key).
- A new **simple Pact module** holds a table
  `{ apollo-public (the key), consumer/lane name, activated:bool, owner-account, ... }`.
- `DeployApolloPythiaApiKey` — **USER-called**, charges **250 STOA** (owner Ouronet
  account → treasury) and inserts the row `activated=false`. The 250 STOA **is** the
  anti-abuse paywall. **No per-account key limit.** A key deployed by someone who can't
  prove ownership simply never turns on and the 250 STOA is lost.
- `TurnApiOn` / `TurnApiOff` — **ADMIN-capped**; ONLY the **HUB Cronoton
  (module-admin keyset)** may flip the boolean. The user CANNOT self-activate even
  though their Apollo seed is in their Codex. **This is why activation is a ping-pong.**
- Ownership proof is ALWAYS the **Ouronet redirect-and-sign handshake**: Pythia issues
  a nonce, the user is redirected to Ouronet/Codex where the Apollo SEED lives, signs
  the nonce, and returns ONLY the signature. The seed NEVER reaches Pythia.
- **Pythia runs `Apollo.verify(sig, nonce, pubkey)`** (pure public-data, Node-side) —
  it is the verifier because **Pact cannot verify Apollo-curve signatures on-chain**.
  On success Pythia **INSTRUCTS the HUB Cronoton** (over an authenticated channel) to
  call `TurnApiOn`.
- **Pythia stays KEYLESS + FUND-LESS.** It verifies signatures, reads the chain via
  `/local`, and instructs the Cronoton — it never signs a chain tx, holds no key, and
  never touches the 250 STOA (a user→treasury on-chain tx).
- **The switch-flipper is THIS Codex Cronoton** — a cron engine in the HUB, **not yet
  upgraded to full "Automaton" status** (pre-Automaton today; see §8). It holds the
  module-admin keyset and submits `TurnApiOn` after ownership is proven + payment
  confirmed.

**Your repo owns exactly one thing in this pipeline: the on-chain flip.** You do NOT
verify Apollo signatures (that is Pythia — it has Dalos; Pact can't). You do NOT hold
the 250 STOA (it never flows through you). You receive a *verified-OK, payment-attested*
signal and you turn the switch — idempotently, admin-capped, as the ONLY party who can.

---

## 1. What already exists in your engine (grounding — I read it)

I read the engine so this handoff names the real seams. The activation capability is a
**new server-resolver + a new authenticated inbound route**, bolted onto machinery you
already ship. Concretely:

### 1a. The tx build/sign/submit path — `lib/codex-cronoton/executor.ts`
`executeCodexTransaction(definition, 'fire')` is the single shared headless executor.
It is a straight port of OuronetUI's `useTransactionBuilder` (`buildTransaction`,
`parseCapabilityLine`, `simulate`, `execute`, `LISTEN_TIMEOUT_MS = 300_000`), rewired
from the browser wallet to the headless **`CodexKeyResolver`**. Its fire path already:

- builds via `Pact.builder.execution(pactCode).setMeta(...).addData(...).addSigner(...)`;
- signs every signer through `resolver.getKeyPairByPublicKey(pub)` →
  `universalSignTransaction`;
- **derives the request key from the signed command hash UP FRONT** (`signedAny.hash`)
  so a lost/timed-out submit (nginx 504 while the node already accepted the tx — the
  documented *OuroMinterStageOne* incident) never records `request_key = NULL`;
- runs a **pre-submit dirty-read pre-flight** and refuses to submit a tx a pre-flight
  would catch (saves gas + a spent one-time attempt);
- on an **ambiguous submit** rebuilds the listen descriptor from the derived key and
  polls by it, and on a **listen timeout** returns `ok:false` but **preserves the
  request key** for recovery — it NEVER throws on a fire.

**This is exactly the primitive `TurnApiOn` needs.** `TurnApiOn` is one small
admin-capped Pact call — a single-tx fire, structurally identical to the
`stoicism-mint` single-tx resolver.

### 1b. The keyset the Cronoton signs with — `lib/codex-cronoton/codex-key-resolver.ts`
`CodexKeyResolver` decrypts signing keys from the **sealed codex snapshot**
(`loadSnapshot()` unsealed under the Hub Master Key / `SECRETS_MASTER_KEY`, password
via `getOrCreateCodexPassword()`). **This is where the module-admin keyset lives / will
live:** the hub already holds coinbase + Stoicism-minter keys here and signs
namespaced admin capabilities with them (the `DALOS.GAS_PAYER` scoped signer synthesis
in `executor.ts::effectiveSigners` is the pattern). The Pythia-module-admin key is
**another codex key resolvable by its public key** — no new key-management surface.

### 1c. Scheduling + the once-only contract — `worker/index.ts` + `lib/codex-cronoton/tick.ts`
- The worker runs `codexCronotonTickOnce(now)` on a **separate 30s throttle**
  (`CODEX_CRONOTON_TICK_INTERVAL_MS`), behind the **leader-only lease** inherited from
  `mainLoop` and an **in-process re-entrancy guard** (`codexTickInFlight`).
- The **PRIMARY double-fire guard** is the per-row atomic
  **`claimDueCodexCronoton(row, now)`** — a conditional `UPDATE` that advances
  (recurring) or clears (one-time) `next_fire_at` **before** the up-to-5-min inline
  fire. Claim wins (`changes === 1`) → fire; claim lost (`changes === 0`) → skip. The
  manual Execute-Now route (`pages/api/admin/codex-cronotons/[id]/execute.ts`) uses the
  **same claim** as a 409 guard.
- Failure policy (REQ-18): **single attempt, no retry, no backoff, no auto-pause**;
  exactly one fire row per fire; the executor's structured `{ ok:false, error }` is
  read, never thrown.

### 1d. The fire-time extension point — `lib/codex-cronoton/server-resolvers.ts`
A **server resolver** is a named hook consulted at fire time, registered via
`registerServerResolver(name, resolver)` and dispatched by `fireByServerResolver`.
Two kinds today: `single-tx` (fill payload from live server data → simulate-guard →
fire → settle; the `stoicism-mint` model) and `multi-tx` (own orchestrator, e.g.
`pool-payout`). **The Pythia activation flip is a new `single-tx`-shaped resolver** —
but sourced from a *queue of verified-OK activation intents* rather than from a daily
schedule (see §3).

### 1e. The authenticated inbound channel already exists — `lib/pool/data-contract-hmac.ts` + `lib/audit-actions/pythia.ts`
Pythia already authenticates every `/api/pythia/*` call with a **dedicated HMAC service
credential** (NOT an admin session, NOT the OIDC client-credentials grant — see the
node-pool handoff §7). `signEnvelope` / `verifyEnvelope` implement **HMAC-SHA256 over a
canonical `{payload, nonce, timestamp}`**, with a **±300s freshness window** and a
**single-use nonce store** (replay protection). The `pythia` audit namespace
(`lib/audit-actions/pythia.ts`) already defines `pythia.auth.reject` with the exact
literal reason 6-set:
`not_configured | invalid_shape | bad_signature | stale_timestamp | future_timestamp | replayed_nonce`.
**Reuse this verbatim for the activation channel — do not invent a second auth scheme.**

### 1f. The on-chain read anchor already exists — `lib/account-verification/read-pubkey.ts`
`readOuronetAccountPublicKey(account)` does a **signing-free `/local` dirty-read** of
`(ouronet-ns.DALOS.UR_AccountPublicKey (read-string "acct"))`, passing the account via
**`addData` (never inlined into Pact code → no injection)**. The **payment-confirmation
read** (§4) is the same shape against the new module's `UR_` accessors.

---

## 2. The four requirements, mapped onto your engine

### REQ-A — Authenticated VERIFIED-OK activation signal (forgery cannot trigger activation)

**New route:** `POST /api/pythia/activate` (same `/api/pythia/*` family as the
node-pool feed + usage push, so it shares the audit surface + the HMAC credential).

**Auth = the existing `verifyEnvelope` gate, unchanged.** Pythia holds the Pythia
service HMAC secret; the hub holds the same shared secret (read from env by the route,
never from the vault — the HMAC module is key-module-free by invariant). The route runs
`verifyEnvelope` in the mandated order: **shape → HMAC → freshness (±300s) →
single-use nonce**. On any failure it emits `pythia.auth.reject` with the matching
literal reason and returns 401/503 (`not_configured` → 503). **A forged signal cannot
pass** because the forger lacks the shared HMAC key; a captured-and-replayed signal
cannot pass because the nonce is single-use within the freshness window; a clock-skew
forge is caught by `future_timestamp`.

**The signed payload (the activation intent) carries:**
```jsonc
{
  "apolloPublic": "<len>.<xy>",   // the key row PK — the activation target
  "consumerLane": "ouronetui",    // attribution label copied onto the flip's audit
  "ownerAccount": "k:...",        // the Ouronet account that deployed the row
  "verifiedAt": "2026-07-08T...", // when Pythia's Apollo.verify passed
  "nonceProofRef": "..."          // opaque handle to Pythia's consumed challenge nonce
}
```

**Custody distinction (LOAD-BEARING — copy the `data-contract-hmac.ts` doc-comment
posture):** a valid HMAC proves the signal **ORIGINATED from Pythia**; it says NOTHING
about whether the Apollo-ownership claim is TRUE. But in this pipeline Pythia IS the
authority on ownership (only Pythia can run `Apollo.verify`), so a verified-OK envelope
from Pythia **is** the ownership attestation. The hub does not re-verify the Apollo
signature (it can't — no Dalos, and Pact can't verify the Apollo curve). **What the hub
DOES independently re-confirm is the 250-STOA payment (REQ-B) — that is the hub's own
chain read, not a Pythia claim.** So the trust split is:
*Pythia attests ownership (HMAC-authenticated), the hub confirms payment (chain-read),
and only the AND of both flips the switch.*

**Two hardening notes:**
1. **Bind the nonce to the exact `apolloPublic`.** The single-use nonce store already
   prevents blanket replay; additionally scope the accepted intent so a replayed or
   reordered envelope can never flip a *different* key than the one Pythia verified.
   The `apolloPublic` is inside the MAC'd payload, so tampering it already fails the
   HMAC — this is belt-and-suspenders at the queue layer (§3): dedupe the queue on
   `apolloPublic` so two intents for the same key collapse.
2. **The channel is one-directional and least-privilege.** The only thing this route
   can cause is `activated` flipping on a Pythia-key row. It cannot move funds, cannot
   touch any other module, cannot mint. Blast radius = "a key gets keyless read/relay
   it may not deserve," which is small — but the HMAC lock + payment re-confirm close
   even that.

### REQ-B — Flip `TurnApiOn` ONLY after ownership proven AND 250-STOA Deploy payment confirmed on-chain

The verified-OK envelope satisfies the **ownership** half. Before the Cronoton signs
`TurnApiOn`, it MUST independently confirm the **payment** half with its own chain read
(never trusting a Pythia-supplied "paid" flag):

- **Read the row from the new module** via a signing-free `/local` dirty-read of a
  `UR_` accessor (same shape as `read-pubkey.ts`), passing `apolloPublic` via `addData`:
  `(pythia-keys-ns.UR_PythiaKeyRow (read-string "apolloPublic"))`. Confirm the row
  exists, `owner-account` matches the envelope's `ownerAccount`, and `activated=false`.
- **Confirm the 250 STOA landed.** The cleanest coupling (resolve this with the Pact
  agent — canonical spec §9 open item "exact tx mechanics coupling the 250 STOA payment
  with the Automaton activation"): have `DeployApolloPythiaApiKey` record a
  **`paid:bool` / `paid-at:time`** (or a `pending-activation` sub-state) **on the row
  itself** at deploy time, so the payment is atomic with row creation and the Cronoton
  confirms it with the *same single `UR_` read* — no separate coin-transfer scan. If
  instead payment is a bare treasury transfer, the Cronoton must scan for the confirming
  tx, which is brittle; **strongly prefer the on-row `paid` flag** so "payment confirmed"
  is one boolean read, chain-confirmed at finality.
- **Both gates pass → sign `TurnApiOn`.** `TurnApiOn` is a single admin-capped Pact
  call built exactly like any other codex tx: `pactCode` =
  `(pythia-keys-ns.TurnApiOn (read-string "apolloPublic"))`, `apolloPublic` via
  `addData`, a single **scoped** signer for the **module-admin public key** carrying the
  `(pythia-keys-ns.ADMIN)` capability (mirror `effectiveSigners`'s scoped
  `DALOS.GAS_PAYER` synthesis), gas paid by the Ouronet gas station or a codex gas-payer
  per your existing gas model. `CodexKeyResolver.getKeyPairByPublicKey(adminPub)`
  resolves + decrypts the admin key from the sealed codex; `universalSignTransaction`
  signs; the executor submits + listens.

- **`TurnApiOff` (revocation) is the mirror image** — same admin cap, same resolver, same
  submit path, `pactCode = (pythia-keys-ns.TurnApiOff (read-string "apolloPublic"))`.
  Trigger it from (a) an owner-initiated deactivate (routed through Pythia →
  authenticated `POST /api/pythia/deactivate` → same queue), or (b) a hub-admin action.
  Pythia keeps its own **instant local denylist** for the revocation-lag window (spec
  §3d) — but the *authoritative* flip is this `TurnApiOff`.

### REQ-C — Idempotency / retry across tx failure + finality lag

**Reuse the engine's existing once-only + finality-safe machinery — do not invent new
retry logic.** Concretely:

- **Queue + claim, exactly like `claimDueCodexCronoton`.** The verified-OK route does
  NOT fire inline in the HTTP request (finality lag makes it multi-second-to-minutes; an
  inline fire would 504 like the pool-payout path did). Instead it **enqueues an
  activation intent** (a new `pythia_activation_intents` row keyed on `apolloPublic`,
  `status='pending'`) and returns **202**. The worker tick claims each pending intent
  with an **atomic conditional UPDATE** (`WHERE status='pending'` → `status='claiming'`,
  `changes===1` wins) BEFORE the up-to-5-min fire — the same claim-before-fire contract
  that makes the cronoton double-fire-proof. A lost claim = another tick already took it
  = skip.
- **Dedupe on `apolloPublic` = natural idempotency.** Two identical verified-OK signals
  (Pythia retried because it didn't see our ack) collapse to one intent row (upsert on
  the PK). Re-running `TurnApiOn` on an already-active key must be **safe/no-op** — make
  `TurnApiOn` idempotent in Pact (if `activated` already true, succeed without change),
  so a redundant flip is harmless.
- **Finality lag is handled by the executor's existing derive-key-up-front + listen
  discipline.** On submit-ambiguity or listen-timeout the executor returns `ok:false`
  **with the request key preserved** — record that on the intent row as
  `status='in-flight'` + `request_key`. A **bounded retry** (unlike the fire-once
  cronoton, activation SHOULD retry — it's a durable intent, not a scheduled fire): the
  next tick re-checks the on-chain `UR_PythiaKeyActivated` first; if the chain now shows
  `activated=true` the earlier ambiguous submit actually landed → mark the intent
  `done` with no re-submit; if still false and the preserved request key's tx failed,
  re-build + re-submit (idempotent `TurnApiOn` makes a double-submit safe). Cap retries
  (e.g. 5) then park as `needs-attention` + audit — never an infinite loop.
- **The chain is the source of truth, not the queue.** Every retry decision starts from
  a fresh `UR_PythiaKeyActivated(apolloPublic)` dirty-read. This is the same "read the
  chain, don't trust the local record" posture the pool aggregation sweep uses
  (`getContinuationStatus` re-derives in-flight state from chain, never from a local
  flag). It makes the whole flow **crash-safe**: a worker restart mid-flight recovers by
  reading the chain, because the intent row + the on-chain `activated` bit together tell
  it exactly where it is.

### REQ-D — The Cronoton is the ONLY party that may flip the switch (users cannot)

- **On-chain:** `TurnApiOn` / `TurnApiOff` are **module-admin-capped** (`(ADMIN)` guarded
  by the module-admin keyset). The only holder of that keyset is the **sealed codex** the
  Cronoton signs from (`CodexKeyResolver`). A user's Apollo seed (in their own Codex)
  authorizes `DeployApolloPythiaApiKey` and *signs Pythia's ownership challenge* — but it
  is **not** the module-admin keyset, so a user tx calling `TurnApiOn` **fails the cap
  on-chain**. This is the enforcement that makes activation a ping-pong: proof goes to
  Pythia, the flip comes only from the hub admin key.
- **Off-chain:** the ONLY input that reaches the `TurnApiOn` builder is a **verified-OK
  HMAC envelope from Pythia** (REQ-A) that ALSO passes the hub's own payment re-confirm
  (REQ-B). There is no admin-UI button, no manual-execute path, and no other route that
  enqueues an activation intent. (If you *do* add a break-glass admin `TurnApiOff` for
  incident revocation, gate it behind `requireFreshAncientAdminConfirmApi` — the same
  Ancient-only, 404-never-403 gate the manual Execute-Now route uses — and audit it.)
- **Keep the admin key out of Pythia's reach forever.** Pythia is keyless by hard rule
  (spec §5.2) and its `keylessScanner` banlists signing symbols. The module-admin key
  lives ONLY in the hub codex. Nothing in this handoff moves it toward Pythia.

---

## 3. Concrete build plan (new files/functions, named against your conventions)

1. **Pact (coordinate with the DALOS/Pact agent — canonical spec §7 "DALOS/hub"):**
   the `pythia-consumer-keys` table + `UR_PythiaKeyRow` / `UR_PythiaKeyActivated`
   read accessors + `DeployApolloPythiaApiKey` (user-capped, 250-STOA transfer, insert
   `activated=false` + `paid=true`) + **admin-capped `TurnApiOn` / `TurnApiOff`
   (idempotent)**. This is the on-chain half; your engine calls into it.

2. **`db/migrations/NNN_pythia_activation_intents.sql`** — the durable intent queue:
   `apollo_public TEXT PRIMARY KEY, consumer_lane, owner_account, status
   ('pending'|'claiming'|'in-flight'|'done'|'needs-attention'), request_key,
   attempts INTEGER, verified_at, created_at, modified_at`. PK on `apollo_public` gives
   free dedupe.

3. **`lib/pythia-activation/store.ts`** — DAO mirroring `lib/codex-cronoton/store.ts`
   discipline (`getDb()`, `@stoachain`-free, static-importable by routes AND the worker).
   Provides `upsertIntent`, `claimPendingIntent(now)` (the atomic conditional UPDATE —
   the `claimDueCodexCronoton` twin), `markInFlight(reqKey)`, `markDone`,
   `markNeedsAttention`, `fetchClaimableIntents`.

4. **`lib/pythia-activation/flip-executor.ts`** — builds the `TurnApiOn` /
   `TurnApiOff` `CodexTxDefinition` (module-admin scoped signer) and fires it via the
   existing `executeCodexTransaction(definition, 'fire')`. Reuses `read-pubkey.ts`'s
   `/local` dirty-read shape for the pre-flip `UR_PythiaKeyRow` payment/owner check and
   the `UR_PythiaKeyActivated` retry re-check. ESM/CJS: `import type` only for
   `@stoachain`, values via the executor (which already dynamic-imports).

5. **`lib/pythia-activation/tick.ts`** — `pythiaActivationTickOnce(now)`, structured like
   `codexCronotonTickOnce`: fetch claimable → atomic claim → chain re-check → flip →
   record → audit → isolate errors. Wire it into `worker/index.ts` **next to**
   `runCodexCronotonTickThrottled` (its own throttle key + the shared re-entrancy /
   leader-lease posture; a flip is fast but the listen can block, so keep it off the
   generic timer).

6. **`pages/api/pythia/activate.ts`** (+ `deactivate.ts`) — the HMAC-gated inbound route:
   `verifyEnvelope` (shared secret from env) → on pass `upsertIntent(pending)` + audit +
   202; on fail `pythia.auth.reject` + 401/503. Mirror the existing `/api/pythia/*`
   route auth exactly.

7. **`lib/audit-actions/pythia.ts` — EXTEND (do not recreate):** append
   `pythia.activation.flip` (`info` + `permanent` — the money-adjacent switch flip is
   forensic; carries `apolloPublic`, `lane`, `on|off`, `requestKey`) and
   `pythia.activation.reject` if you want a distinct verb from `auth.reject`. The file's
   header already documents the append-only, define-now-emit-later convention.

8. **`components/admin/...` (optional, read-only):** surface the intent queue +
   flip-fire history in `/hub` next to the codex-cronotons view, reusing the fire-history
   pattern. No new *control* surface (REQ-D: no button flips the switch).

---

## 4. On-chain call shapes (the two the Cronoton issues)

```lisp
;; Signing-free /local dirty-read — pre-flip gate (payment + owner + not-yet-active).
;; Same shape as lib/account-verification/read-pubkey.ts (account via addData, not inlined).
(pythia-keys-ns.UR_PythiaKeyRow (read-string "apolloPublic"))
;;   -> { apollo-public, consumer-lane, activated:false, owner-account, paid:true, ... }

;; Admin-capped flip — the ONLY write the Cronoton signs, module-admin keyset only.
(pythia-keys-ns.TurnApiOn (read-string "apolloPublic"))     ;; idempotent: no-op if already true
(pythia-keys-ns.TurnApiOff (read-string "apolloPublic"))    ;; revocation mirror
```

- `apolloPublic` is passed via `addData("apolloPublic", "<len>.<xy>")` — **never**
  interpolated into the Pact code string (injection-safe, per `read-pubkey.ts`).
- Signer: one **scoped** signer for the module-admin public key with the module's
  `(pythia-keys-ns.ADMIN)` capability, synthesized the way `effectiveSigners` synthesizes
  the scoped `DALOS.GAS_PAYER` signer. Resolve the admin keypair with
  `CodexKeyResolver.getKeyPairByPublicKey(adminPub)`.
- Route Pact IO through the **co-located loopback chainweb node** (`localChainwebBaseUrl`)
  exactly as the executor already does — node1/node2 are unreachable from the hub box.

---

## 5. Hard rules this handoff inherits (must not violate)

1. **Pythia never signs a chain tx and holds no key.** The flip is 100% hub-side. Do not
   design any path where Pythia holds the module-admin key.
2. **Pythia never touches the 250 STOA.** The payment is a user→treasury on-chain tx the
   Pact module records; the Cronoton *reads* the `paid` flag, it does not receive funds.
3. **The Pythia→Cronoton channel is authenticated** (HMAC `verifyEnvelope`, single-use
   nonce, ±300s window). Only a verified-OK envelope can enqueue an intent.
4. **The chain is the source of truth for every retry decision** (re-read
   `UR_PythiaKeyActivated` before any re-submit); the local intent row is a work-tracker,
   not the truth.
5. **The Cronoton is the sole flipper.** On-chain admin cap + no off-chain control surface
   = users provably cannot self-activate. Any break-glass admin flip is
   Ancient-gated + audited.
6. **`TurnApiOn` is idempotent** so a finality-lag double-submit is harmless.
7. **Fail-open does NOT apply here** (that is Pythia's *read* posture). An activation flip
   that can't confirm should **park as `needs-attention`**, never optimistically mark
   `done`.

---

## 6. Idempotency / finality state machine (the intent row lifecycle)

```
pending ──claim(atomic UPDATE, changes===1)──▶ claiming
   ▲  (lost claim → skip; another tick owns it)
   │
claiming ──chain re-read UR_PythiaKeyActivated──┐
   │                                            │ already true → done (no submit; the
   │                                            │   earlier ambiguous submit landed)
   │                                            │
   │            still false ──build+sign+submit TurnApiOn (executor, key derived up front)
   │                                            │
   │            ok:true (listened) ─────────────┴──▶ done  (audit pythia.activation.flip on)
   │            ok:false + requestKey preserved ────▶ in-flight  (record request_key)
   │            ok:false hard (no submit) ──────────▶ pending (bump attempts) or
   │                                                  needs-attention at cap
in-flight ──next tick: re-read UR_PythiaKeyActivated──┐
                                                      │ true  → done
                                                      │ false → re-submit (idempotent) or
                                                      │         needs-attention at cap
```

This is the pool-aggregation-sweep pattern (`burned`/`continued` legs re-derived from
chain via `getContinuationStatus`, never from a local flag) applied to a one-shot flip.

---

## 7. Test posture (match your `.bee` conventions)

Unit-testable with mocks (the engine's on-prod-only discipline):

- **Auth gate:** every `verifyEnvelope` failure reason maps to `pythia.auth.reject` +
  the right HTTP code; a tampered `apolloPublic` fails HMAC; a replayed nonce is rejected;
  a stale/future timestamp is rejected. (Reuse `data-contract-hmac`'s existing test
  patterns.)
- **Claim once-only:** two overlapping ticks on the same pending intent → exactly one
  claims (mock the conditional-UPDATE `changes`), mirroring the `claimDueCodexCronoton`
  tests.
- **Payment gate:** a `paid:false` (or missing) row → NO flip, park; a `paid:true` +
  `activated:false` + owner-match → flip.
- **Finality/idempotency:** ambiguous-submit + preserved request key → next tick reads
  chain `activated:true` → `done` with NO second submit; chain still false → one bounded
  re-submit; cap → `needs-attention`.
- **REQ-D negative:** assert there is no non-HMAC route that enqueues an intent and no
  admin UI that calls the flip builder directly (grep-level guard test, like the p6
  no-unsanctioned-regression tests).

On-prod-validated (native binary + live node + provisioned codex): the real
`UR_` dirty-read, the real `TurnApiOn` submit/listen, the real admin-key decrypt.

---

## 8. Pre-Automaton note (explicit)

Today this engine is a **Codex Cronoton**, not the full **Automaton**. The canonical
spec and the OuronetUI/Pythia companions sometimes say "Automaton flips the switch" — in
the current world **that flipper is this Codex Cronoton**, holding the module-admin
keyset in the sealed codex and firing through `executeCodexTransaction`. Nothing here
requires Automaton status: the activation resolver rides the exact machinery the daily
Stoicism mint and pool-payout already use. When the engine is later promoted to
Automaton, the activation resolver moves with it unchanged (it is a registered
server-resolver + an intent queue — both engine-version-agnostic). **Design the intent
queue + flip-executor as engine-hosted server-side modules, not as Automaton-specific
code, so the promotion is a no-op for this feature.**

---

## 9. Open questions for YOUR repo (resolve before/while building)

1. **Payment coupling (the canonical spec's biggest open item, §9):** confirm with the
   Pact agent that `DeployApolloPythiaApiKey` writes an **on-row `paid` flag atomically
   with the 250-STOA transfer**, so the Cronoton's payment gate is one `UR_` boolean read
   rather than a treasury-tx scan. If the module can't co-locate `paid` on the row, define
   the exact confirming-tx read the Cronoton must do and its finality depth.
2. **Module-admin keyset provenance:** is the Pythia-module `(ADMIN)` cap guarded by the
   **same** hub keyset the Stoicism minter / pool payout already use (already in the
   codex), or a **new** dedicated Pythia-admin keyset (cleaner blast-radius isolation)?
   Recommend a dedicated key, still codex-resident, so a Pythia-module compromise can't
   reach the mint path.
3. **Retry cap + `needs-attention` SLA:** how many bounded re-submits before parking, and
   what surfaces the parked queue to the Ancient (audit feed only, or a `/hub` panel)?
4. **Revocation lag SLA:** the authoritative `TurnApiOff` + Pythia's instant local
   denylist (spec §3d) — agree the max window between an owner-initiated revoke and the
   on-chain flip, and whether `TurnApiOff` needs the same payment gate (it does NOT — a
   revoke is free).
5. **Tick cadence:** a dedicated activation-tick throttle vs. folding activation-intent
   draining into the existing 30s codex-cronoton throttle. Recommend a **separate short
   throttle** (activation should feel near-instant to the user finishing the redirect;
   the daily-cron cadence is too slow), reusing the leader-lease + re-entrancy guard.

---

*Grounded against: `lib/codex-cronoton/executor.ts`, `tick.ts`, `store.ts`,
`server-resolvers.ts`, `codex-key-resolver.ts`, `types.ts`;
`pages/api/admin/codex-cronotons/[id]/execute.ts`; `worker/index.ts`;
`lib/pool/data-contract-hmac.ts`; `lib/pool/payout-cronoton.ts`;
`lib/account-verification/read-pubkey.ts`; `lib/audit-actions/pythia.ts`
— all in `D:\_Claude\StoaOuronet\AncientHoldings`. Canonical spec:
`D:\_Claude\AncientPantheon\Pythia\docs\PYTHIA-CONSUMER-KEY-MODEL.md`.*