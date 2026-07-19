# pythia-sovereign-automaton — Design

## Problem
The Pantheon defines an automaton as **Codex (sealed keys + signing) + Pythia (chain reads)
+ Khronoton (scheduled signing) + domain logic** (`automaton/04`). Pythia-the-service is
today classified as a *constructor-service that deliberately skips the Codex and Khronoton*,
so she cannot make her own on-chain transactions — she **delegates** them (the daily Pyth
ledger flush, consumer-key API activation) to the **Dalos** automaton. That makes her a
dependent half-organ rather than a sovereign entity. She should be a **full automaton** that
signs her own transactions, while the surface she gives clients stays **keyless**.

## Approach
Promote the Pythia service to a full Pantheonic automaton by applying the **proven Mnemosyne
blueprint** (Codex + Khronoton organs + `automaton/02` master-key sealed protection), split
cleanly into two isolated halves:

- **Pythia-Automaton (the entity / core).** A sealed **Codex** holding her signing key(s) +
  a **Khronoton** schedule. It performs her *sovereign* transactions — nothing else:
  1. the **daily Pyth ledger flush** → `ouronet-ns.PYTHIA.A_Flush` (today delegated to Dalos);
  2. **consumer-key API activation** transactions (the on-chain half of the consumer-key model).
  **Gas is paid by the Ouronet gas station** — Pythia *signs*, the station *funds* — so her
  Codex holds signing keys but **needs no gas balance** (a much smaller, safer key than a
  spending wallet).
- **Pythia-Constructor — named "Pythiaeyes."** The keyless read/relay gateway that clients and
  other automatons consume, unchanged. It **never touches the Codex** and never signs. This is
  the organ the automaton triad refers to as "Pythia (reads)"; going forward it is Pythiaeyes —
  the oracle's *eyes* on the chain. (Naming settled by the owner.)

This ships as **v2.0.0** — the major bump reflects Pythia becoming a sovereign automaton (keys +
signing) and the keyless invariant being reframed.

Alternatives rejected: keep delegating to Dalos (leaves her non-sovereign and coupled to
Dalos availability); give her a funded spending wallet (unnecessary — the gas station funds;
a signing-only key is a smaller attack surface); build a general Codex/wallet UI like
Mnemosyne's (she has exactly two autonomous actions, not human-operated signing).

### The keyless invariant — reframed, not abandoned
Today: *"the whole Pythia process holds no keys."* After: **"Pythia's constructor face — the
client request path — holds and uses no keys; keys live only in the sealed Codex, used only
by Khronoton-scheduled sovereign actions, never in response to a client request."** This is
exactly how Mnemosyne already runs (a public automaton with a Codex whose client surface never
exposes it). The `keylessScanner` is **rescoped**: it enforces keylessness over the
**constructor modules** (the request path), while the Codex + Khronoton core is the explicitly
keyed part behind a hard boundary.

### Isolation contract (the whole ballgame)
- The client request path imports **only** constructor modules. It has no import path to the
  Codex, the signing code, or Khronoton — enforced by the rescoped `keylessScanner` and, ideally,
  a package/process boundary (Codex+Khronoton in their own module the request path cannot reach).
- The Codex is **master-key sealed** (`automaton/02` + Pythia's existing sealed vault). A
  missing/wrong master key → the automaton core is **dormant** (flush + activation don't run,
  surfaced in admin) while the **constructor face keeps serving reads** unaffected.
- Only two triggers may invoke a signature: the **Khronoton schedule** (the daily flush) and
  the **ancient-gated internal path** for activation — never a public route.

## Acceptance criteria
- [ ] Pythia signs + submits her **own** daily `PYTHIA.A_Flush` from her Codex on a Khronoton
      schedule — no Dalos delegation — with gas funded by the Ouronet gas station.
- [ ] Pythia signs + submits **consumer-key API activation** transactions herself, gas via the
      station; her Codex carries **no gas balance requirement**.
- [ ] The client request path is **provably keyless**: the rescoped `keylessScanner` passes over
      the constructor modules and the request path has no import reaching the Codex/signing/Khronoton.
- [ ] A missing/wrong Codex master key leaves the **automaton core dormant** (flush/activation
      paused, shown in admin) while **reads keep being served** — no client-facing regression.
- [ ] The Codex is master-key sealed with rotation, per `automaton/02` (reusing Pythia's sealed vault).
- [ ] Naming is consistent: the entity is **Pythia (automaton)**, the constructor face is
      **Pythiaeyes**, reflected in code + docs.
- [ ] **Update & Deploy shows a multi-version readout** (Mnemosyne-style, `automaton/` §10 + the
      `UpdateDeployPage` reference): installed → available for **Pythia** *and* the **Codex** and
      **Khronoton** organs, so an operator sees when an organ upgrade is available before deploying.
- [ ] The Pantheonic Architecture library is updated (owner) to reclassify Pythia from
      "constructor-service (skips Codex/Khronoton)" to "automaton exposing the Pythiaeyes keyless
      constructor face," and to reframe the keyless invariant accordingly.
- [ ] Ships as **v2.0.0**.

## Topics (project decomposition — shaped one at a time)
1. **codex-integration** — consume `@ancientpantheon/codex`; a master-key-sealed Codex holding
   Pythia's signing key(s), rotation per `automaton/02`, reusing the existing sealed vault. Dormant
   without the master key. No signing wired yet.
2. **sovereign-actions** — consume `@ancientpantheon/khronoton`; wire the schedule + the two signing
   actions (daily `PYTHIA.A_Flush`; consumer-key API activation), gas via the Ouronet station.
3. **keyless-isolation** — rescope `keylessScanner` to the constructor (Pythiaeyes) modules; prove
   the request path cannot reach the Codex/Khronoton; the dormant-core fallback.
4. **pythiaeyes-naming** — rename the constructor face to Pythiaeyes across code + docs; draft the
   architecture-library reclassification + reframed keyless invariant for the owner to ratify.
5. **multi-version-deploy** — the Update & Deploy readout showing Pythia + Codex + Khronoton
   installed → available (Mnemosyne `UpdateDeployPage` pattern).
6. **v2.0.0-release** — the major bump + changelog once the above land.

## The full Codex organ — UI and everything, like Mnemosyne (IN scope)
Pythia gets the **complete Mnemosyne Codex functionality baked in**, not a headless import:
- The **`@ancientpantheon/codex` UI** mounted in the admin — the ancient is presented with an
  **empty codex** they can start adding keys to, or **load** an existing codex into.
- **Download** the codex, **re-encrypting it on the spot under a password of their choice**
  (the export flow); **reload** a codex file, which **re-seals it under the codex key Pythia
  holds** (the load-and-adopt flow) — the same download/reencrypt/reload cycle Mnemosyne has.
- The **server Codex adapter** (the `MnemosyneServerCodexAdapter` shape) persists the snapshot
  **master-key sealed via Pythia's canonical libsodium vault** (Topic 1); server-held
  auto-unlock. `rekeyCodex` powers the download-reencrypt and load-adopt password swaps.
- Since Pythia's admin is vanilla JS (not Next.js/React), this brings a **React island +
  bundler** for the codex admin surface — that infrastructure is part of the work.

## Out of scope
- A general-purpose wallet / arbitrary signing beyond what her cronotons need.
- Holding or managing a gas balance (the Ouronet gas station funds).
- Reward/PythXP minting — still the hub's job, unchanged.
- Renaming the `@ancientpantheon/pythia-client` npm reads library (its consumers are external);
  the "Pythieyes" term applies to the service's constructor face + the automaton-triad organ name.

## Grounded build recipe (from Mnemosyne + `pantheonic-architecture/`)
Verified against the architecture docs AND Mnemosyne's code (the reference automaton). Port,
don't invent:

- **Packages:** `@ancientpantheon/codex@^0.6.0`, `@ancientpantheon/khronoton-core@^0.4.0`
  (`/server`, `/handlers`, `/blockchain/stoachain`), `@stoachain/{stoa-core,kadena-stoic-legacy,
  ouronet-core}`, `libsodium-wrappers`, `better-sqlite3` (native — needs a Dockerfile deps stage).
- **Codex sealing = the canonical `automaton/02` method (settled — verified in the hub AND
  Mnemosyne code, and documented in `automaton/02` §8b).** ONE libsodium `crypto_secretbox`
  vault under a single **`PYTHIA_MASTER_KEY` (32-byte base64)**, file-based (Mnemosyne variant,
  since Pythia has no DB). Port `mnemosyneVault.ts` (seal/unseal), `mnemosyneCodexStore.ts` (the
  sealed snapshot + codex-password files, atomic temp→rename, on `/data`), `keyResolver.ts`
  (unseal → `smartDecrypt` → resolve the signing keypair), and the generic-re-seal rotation
  (`automaton/02` §4). **Convergence:** Pythia's interim AES-GCM `SealedVault` is retired — the
  hub HMAC operator secret migrates into the one libsodium vault as an ordinary entry, so Pythia
  ends with **one vault, one `seal()`** over {codex snapshot, codex password, HMAC secret}.
  Server-held auto-unlock (no prompt). *Implication:* `PYTHIA_MASTER_KEY` changes format
  (hex → 32-byte base64) and the live HMAC secret is re-sealed under it — a one-time migration.
- **Khronoton:** `installSchema(db)` + `startKhronotonLoop({db, resolver, runtime, onAudit,
  resolveFireMode, config})` at boot (kill-switch `KHRONOTON_DISABLED`); a failed start is caught,
  never fatal (dormant-safe). `runtime` = `createStoachainRuntime()`. Register a cronoton =
  `commitCodexCronoton({name, envelope:{pactCode,config,payload,gasPayer,signers}, schedule})`.
- **Sign→submit** is entirely inside khronoton-core's executor (build → resolver-sign →
  dirty-read pre-flight → auto-gas → submit → listen; claim-before-fire = exactly-once). Pythia
  supplies the resolver (its Codex) + the runtime (its network client).
- **Gas:** `gasPayer:{type:"gas-station"}` → sender = the station account
  (`STOA_AUTONOMIC_OURONETGASSTATION`), a scoped `DALOS.GAS_PAYER` signer is synthesized; Pythia's
  key only **authorizes** the domain cap, never funds. ✔ signing-only key confirmed.
- **The two txs:** daily `ouronet-ns.PYTHIA.A_Flush(day, at, …6 metrics)` (guard `WRITE-LEDGER`);
  `APIARY.A_TurnApiOn(apolloPublic)` for consumer-key activation (cap `APIARY|CRONOTON`).
- **Multi-version deploy:** extend the existing `versionInfo.ts` (built in 1.12.0) into the
  Mnemosyne `ConstructorsStatus` shape — app installed (local pkg) vs available (GitHub raw) +
  per-organ installed (`node_modules/<pkg>/package.json`) vs available (npm registry
  `dist-tags.latest`), `isNewerVersion` segment-compare, `anyUpdateAvailable`.

## External dependencies (owner / Pact / hub side — block LIVE firing, NOT the scaffolding)
The grounding surfaced that the actual on-chain *firing* of the two sovereign txs depends on
pieces **outside the Pythia repo**, which the owner/Pact/hub side must line up. The Codex +
Khronoton scaffolding builds + tests (in `simulate`/`test` mode) without them:
1. **`PYTHIA.A_Flush` guard** must be re-pointed from `dalos-automaton-guard` to **Pythia's own
   automaton keyset** (on-chain module change).
2. **`APIARY` module + `apiary-cronoton-keyset`** provenance must move so **Pythia's Codex key**
   is the authorized activation signer (currently the HUB Codex Cronoton).
3. **Gas-station authorization** — how the Ouronet station consents to fund *Pythia's* signer
   (the `gasStationSignerKey` / cap contract) is not specified in the docs.
4. **Verifier location** (Pythia vs hub) for consumer-key activation — explicitly open.
These are flagged for the owner; they gate `sovereign-actions` going *live*, not topics 1/2/4/5/6.

## Topics — buildability
- **1 codex-integration** — BUILDABLE now (decision made). Foundation.
- **2 khronoton-engine** — BUILDABLE now (port Mnemosyne; adds `better-sqlite3`).
- **3 sovereign-actions** — wiring BUILDABLE + testable in `simulate`; LIVE firing gated on the
  external deps above.
- **4 keyless-isolation** — BUILDABLE now (rescope `keylessScanner` to the Pythiaeyes modules).
- **5 pythiaeyes-naming** — BUILDABLE now.
- **6 multi-version-deploy** — BUILDABLE now (extend `versionInfo.ts`).
- **7 v2.0.0-release** — after the above.
