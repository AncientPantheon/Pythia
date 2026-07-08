# Pythia consumer-key model — settled spec (on-chain Apollo key + activation)

**Status:** agreed direction (owner + assistant, 2026-07-08). Settles the Codex-side
discussion in `Codex/docs/PYTHIA-CONSUMER-KEY-MODEL.md`, grounded by a 12-agent
analysis of the real Dalos crypto, the on-chain DALOS/CODEX Pact modules, the
Automaton, and Pythia's current key store. NOT yet implemented — this is the spec
to hand to the Pythia, DALOS/hub, Codex, and OuronetUI agents.

---

## 1. The model in one paragraph

A Pythia **API key is an Apollo Account** — its `₱./Π.` Apollo public key. The key
is registered **on-chain** and is **inert until its owner proves possession** to
Pythia by *signing a challenge where the keys live* (OuronetUI/Codex); Pythia then
has the **DALOS Automaton** flip the on-chain `activated` boolean to `true`.
Consumers **bake the public key** into their build; the Codex forwards it as a
request header; Pythia — which stays **keyless** — reads the on-chain *activated*
set (cached) and grants **read + relay-of-signed-tx** access. Because Pythia is
keyless, an embedded public key can never move funds, which is what makes it safe
to bake into a public/permaweb bundle.

## 2. Actors

- **OuronetUI + Codex (client)** — holds the Apollo Account keys (unlocked wallet).
  Signs Pythia's activation challenge. Bakes its Apollo **public** key into the
  build; the Codex reads that baked key and sends it to Pythia.
- **Pythia (keyless read-engine + verifier + activation oracle)** — reads the
  on-chain registry (cached, fail-open), verifies Apollo signatures with Dalos
  (`Apollo.verify` — pure public-data), and *instructs* the Automaton to activate.
  Never signs a chain tx, never holds a key.
- **DALOS Automaton + on-chain module (hub layer)** — holds module-admin authority;
  submits the registration/activation txs; the on-chain table is the source of truth.

## 3. Lifecycle

### 3a. Create + register (inactive) — an Ouronet-account action
- The user creates an **Apollo Account** in OuronetUI. (Today this is gated behind
  "experimental"; **un-gate it** so Apollo Accounts can be created normally.)
- OuronetUI places the Apollo Account on-chain (the way an Ouronet Account is placed
  on-chain), with its Pythia-API entry `activated = false`. This is authorized by the
  **Ouronet account** — it does NOT require the Apollo private key. Anyone can bring
  an (inactive) key on-chain.
- The Apollo **public** key is baked into the consumer build (permaweb-safe).
- The Apollo Account's **seed lives in the operator's Codex** — the Codex is a key
  collection, the natural vault for an operator's many API-key seeds. Only the
  **public** key ships in the consumer bundle; the seed never leaves the Codex.
- **No per-account key limit.** Abuse is deterred economically instead (see §3b):
  activation costs **250 STOA**.

### 3b. Activate — prove Apollo ownership → Automaton flips `true`

```
 owner (OuronetUI/Codex, keys here)        Pythia (keyless verifier)        DALOS Automaton + chain
 ───────────────────────────────────       ──────────────────────────       ─────────────────────────
 1. "activate my key <pubkey>"      ─────▶  2. mint fresh single-use nonce
                                            (short TTL), store it
                                    ◀─────  3. redirect to OuronetUI(nonce, return)
 4. SIGN nonce with Apollo priv key
    (client-side; SEED NEVER LEAVES)
                                    ─────▶  5. return {pubkey, signature}
                                            6. Apollo.verify(sig, nonce, pubkey)
                                               + pubkey is registered on-chain
                                               + nonce unconsumed → consume it
                                            7. instruct Automaton (authed channel) ─────▶  8. admin-capped tx:
                                                                                            activated = true
                                                                                            (on finality)
```

- **Step 4 is the whole point** and the hard rule: the Apollo seed/private key is
  used **only** to sign, **only** inside OuronetUI/Codex. Pythia receives the
  **signature**, never the secret.
- Pythia is the natural verifier because **Pact cannot verify an Apollo-curve
  signature on-chain** (Apollo is a custom Twisted-Edwards/Schnorr scheme; Pact only
  does ED25519/WebAuthn). So an off-chain verifier that has Dalos is *required*, and
  the Automaton bridges the verified result on-chain. (Registration is an ED25519
  Ouronet-account tx the chain *can* do; activation needs the off-chain Apollo proof.)
- **The signing handshake reuses a PROVEN mechanism.** Redirecting to Ouronet to sign
  is exactly how the HUB already verifies Ouronet Accounts — so this is not new
  infrastructure, it's that pattern applied to the Apollo key. Signing is **always** in
  Ouronet/Codex (where the seed lives); Pythia never receives a seed.
- **Activation is paywalled at 250 STOA (anti-abuse).** To flip a key to `active`, the
  user pays **250 STOA** from their Ouronet account during the handshake; the Automaton
  flips `activated = true` only after BOTH the Apollo-ownership proof (off-chain) AND
  the payment (on-chain). This gates *live* keys behind a cost so abusers can't flood
  the chain with activated keys nobody uses — replacing any per-account limit. Pythia
  stays fund-less (the payment is a user→treasury on-chain tx the module verifies; it
  never flows through Pythia). 250 STOA is a governance-adjustable knob;
  registration-inactive stays cheap/free since inactive keys are never served.

### 3c. Use (per request — for everyone)
- The consumer (carrying its baked public key) calls Pythia; Pythia checks the
  **cached on-chain activated set**; if `activated`, it grants read/relay and
  attributes usage to that key's lane. Once a consumer's key is active, **all** its
  users share that lane (it's baked into the shared build).

### 3d. Revoke
- The owner or the module admin flips `activated = false` on-chain. Pythia stops
  honoring it on the next cache poll. For **instant** revocation, Pythia keeps a
  **local denylist override** (on-chain flip + finality + poll has a lag).

## 4. Two lanes (classify by secrecy, not mutability)

- **Public-key-identifier lane (default; permaweb + standard consumers).** The baked
  key is a **public identifier**. It is **copyable-but-harmless** — anyone who lifts
  it from a public bundle can only burn that lane's rate budget / pollute its stats,
  never move funds (Pythia is keyless). Gated by **activation** (ownership was proven
  once, at 3b). Optional hardening: **origin binding** (allowed origins stored on the
  row; Pythia enforces `Origin`/`Referer`) + per-key rate limits — stops casual
  cross-site key-lifting, not determined non-browser abuse.
- **Signing lane (optional; server-backed consumers only).** For consumers that can
  keep a secret at runtime and want **copy-proof** per-request identity: each request
  (or session) carries a signature over a fresh Pythia nonce, verified with
  `Apollo.verify`. Never for a permaweb bundle (a public bundle has no secret to sign
  with; `generateFromSeedWords` is deterministic, so a baked seed is a published
  secret).

## 5. Hard rules (non-negotiable)

1. **The seed/private key never reaches Pythia.** Signing happens in OuronetUI/Codex;
   only the signature travels. No "paste your seed into Pythia" path.
2. **Pythia stays keyless.** It verifies signatures (public data), reads the chain via
   `/local` (`signers:[]`, `sigs:[]`), and *instructs* the Automaton — it never signs
   a chain tx and holds no key. Add Apollo's `sign`/`generateFrom*` symbols to
   `keylessScanner`'s banlist so signing can never be smuggled into Pythia's source.
3. **The Pythia→Automaton channel is authenticated** (only Pythia can request an
   activation) — else a third party could activate arbitrary keys. Blast radius is
   small (activation only grants keyless read/relay), but lock it down.
4. **Registry reads are cached + fail-OPEN.** Chain/node unreachable → Pythia serves
   reads from the last-good activated set (bounded max-stale) and falls back to the
   community lane. The keyless read path must never go down because the chain did.
5. **No per-request on-chain writes.** Usage stays "Pythia meters, hub mints"
   aggregate; if ever inscribed on-chain, it is **batched** via the Automaton
   (~60–120s), never per request.

## 6. On-chain registry (Pact sketch — needs a GOV/Demiurgoi module upgrade)

> The schema below is an illustrative sketch. The **grounded, house-style** Pact surface (module APIARY, C_DeployApolloPythiaApiKey, A_TurnApiOn/Off, UR_ reads) and all cross-component interfaces are settled in HANDOFF-consumer-key-INTERFACES.md - that ICD is authoritative.

```lisp
(defschema pythia-consumer-key
  @doc "One Pythia API key = an Apollo Account public key. Inert until activated. \
        Pythia READS this (dirty /local) and caches the activated rows."
  apollo-public :string   ;; the '{len}.{xy}' Apollo public-key encoding (verify() input)
  consumer-lane :string   ;; attribution label: 'ouronetui' | 'aletheia' | ...
  activated     :bool     ;; the switch — flipped true only after Apollo-ownership proof
  owner-account :string   ;; the ouronet account that registered it
  origins       :[string] ;; optional allowed origins for soft binding
  registered-at :time  updated-at :time)
(deftable pythia-consumer-keys:{pythia-consumer-key})   ;; key = apollo-public

;; Free, gasless, signing-free reads Pythia calls in a /local dirty read:
;;   (UR_PythiaKeyActivated apollo-public) -> bool
;;   (UR_PythiaKeyRow       apollo-public) -> object   ;; row or {}
;;   (UR_ListPythiaKeys)                   -> [object]  ;; the public directory
;; Writes: (register ...) — Ouronet-account capped;
;;         (A_ActivatePythiaKey pubkey) / (A_DeactivatePythiaKey pubkey) — module-admin
;;         capped, submitted ONLY by the Dalos-Automaton (after Pythia's off-chain proof)
;;         or by an admin. NO per-key request counter here.
```

Resolve first: verify against the **deployed** module (the archived `.pact` may have
drifted), and confirm the Apollo string used is the Apollo Account `₱./Π.` key.

## 7. What each repo builds

- **DALOS / hub (Pact + Automaton):** the `pythia-consumer-keys` table + `UR_` read
  accessors + admin-capped `A_Activate/Deactivate` defuns; the Automaton's activation
  tx; the authenticated trigger Pythia calls. (Owner-side registration reuses the
  existing account-placement path.)
- **OuronetUI:** un-gate Apollo Account creation; add **"Activate Apollo Pythia API
  Key"** (place-on-chain + the sign-the-challenge redirect handshake); bake its Apollo
  public key at build time.
- **Codex:** read the consumer's baked public key and send it as the Pythia key header
  (one field on the injected connection config; `createPythiaConnection` already
  exists). The Codex also **stores the operator's Apollo API-key seeds** (it is already
  a key vault) and **signs the activation challenge** during the Ouronet redirect.
  Optionally: a `signChallenge(nonce)` callback for the per-request signing lane.
- **Pythia:** a cached on-chain registry **mirror** (read-only, `/local`, ~60s,
  fail-open); the **grant check** as the first branch of `resolveConsumer` (verify
  activated → map to lane, else fall through to store→env→direct); the **public
  directory** (list all registered keys + activated status + count — Pythia is a read
  engine, it shows them all regardless of the switch); the **activation verifier +
  Automaton trigger** (unless hosted by the hub — see §8); optional signing lane +
  origin binding + per-key rate limits. All behind an **env flag** so it boots dark
  and rolls back to the current shared-secret store instantly.

## 8. One design choice to settle: who hosts the activation verifier?

- **Pythia (owner's suggestion):** reuses the Dalos verifier Pythia needs anyway for
  the signing lane; one "prove to Pythia" surface; Pythia triggers the Automaton.
- **The hub/DALOS layer:** keeps Pythia a *pure read engine* (no write-triggering
  authority, no Automaton coupling); activation lives where the Automaton + admin
  governance already are; Pythia just reads the result.

Both are sound. Slight lean to the **hub owning the write-path** for cleaner
separation, but Pythia-verifies is legitimate. Pick deliberately.

## 9. Resolved vs open

**Resolved:** the key is an **Apollo Account** (`₱./Π.`); register-inactive is
separate from activate-on-proof; **seeds live in the operator's Codex**; signing is
**always** the Ouronet redirect handshake (reusing the HUB's proven Ouronet-account
verification), never the seed sent to Pythia; **no per-account key limit — a 250 STOA
activation paywall** deters abuse instead; Pythia stays keyless + fund-less and reads
a cached, fail-open mirror; no per-request on-chain counting; this **coexists** with
the current shared-secret store (opt-in third lane, env-gated).

**Open:** feasibility/timeline of the GOV module upgrade; the **exact tx mechanics
coupling the 250 STOA payment with the Automaton activation** (escrow/pending-activation
vs verify-then-flip); revocation-lag SLA + denylist override; verifier location (§8);
origin-binding scope; empirically confirm the Dalos `generateFromSeedWords → sign →
verify` round trip before shipping the signing lane.

## 10. Phased plan

- **P0 — Ratify** this spec; confirm the deployed module + the `₱./Π.` key choice.
- **P1 — On-chain registry** (DALOS/hub): the table + `UR_` reads + admin-capped
  activate/deactivate + the Automaton tx + the authenticated Pythia→Automaton trigger.
- **P2 — Pythia read mirror**: cached activated-set read (`/local`, fail-open) + the
  public directory/count.
- **P3 — Grant check**: crypto lane as the first branch in `resolveConsumer`; env-gated.
- **P4 — Activation flow**: Pythia (or hub) nonce challenge + the OuronetUI
  sign-and-return handshake + verify + Automaton trigger.
- **P5 — OuronetUI + Codex**: un-gate Apollo Accounts, "Activate Pythia API Key" UI,
  bake the public key, Codex forwards it. First real consumer end-to-end.
- **P6 (optional)**: signing lane + origin binding + rate-limit tiers; batched on-chain
  usage mirror only if justified.
