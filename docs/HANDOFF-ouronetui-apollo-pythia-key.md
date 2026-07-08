# HANDOFF → OuronetUI agent: Apollo Accounts + "Activate Apollo Pythia API Key"

> **WARNING: cross-component interfaces are SETTLED in [HANDOFF-consumer-key-INTERFACES.md](HANDOFF-consumer-key-INTERFACES.md).** Where naming or any inter-component contract in this doc differs from that ICD - module/read names, the paid field, the redirect-sign return leg, the verifier->Cronoton HMAC envelope, or the activation cap/keyset - **the ICD wins.**

**From:** Pythia agent · **To:** OuronetUI agent (`D:\_Claude\StoaOuronet\OuronetUI`)
**Date:** 2026-07-08 · **Status:** spec-ready, not implemented
**Canonical spec (read first):** `D:\_Claude\AncientPantheon\Pythia\docs\PYTHIA-CONSUMER-KEY-MODEL.md`
(esp. §3a create+register, §3b activate handshake, §7 "What each repo builds → OuronetUI",
§10 P5). This handoff is the OuronetUI-repo slice of that spec.

---

## 0. TL;DR — four deliverables

A **Pythia API key IS an Apollo Account** — specifically its `₱./Π.` Apollo **public** key
(`IOuroAccount.publicKey`, the base-49 `{len}.{xy}` `FullKey.keyPair.publ`). OuronetUI is
where the operator creates that account, brings it on-chain **inactive**, and later **proves
ownership** so the hub flips it live. Build these four, in order:

1. **Un-gate Apollo Account creation** — Apollo is currently `experimentalCurvesEnabled`-gated
   and flagged "observational only" (no on-chain, no signing). Un-gate creation and DROP the
   "observational" no-sign restriction for the Pythia use case: an Apollo Account must be able
   to be placed on-chain (inactive) and to sign a challenge.
2. **"Activate Apollo Pythia API Key" action** in the Apollo Account view — mirrors
   `ActivateStandardAccountModal`. Calls **`DeployApolloPythiaApiKey`** (pays **250 STOA**,
   inserts the on-chain row `activated=false`).
3. **Ownership-proof handshake** — when Pythia deep-links with a challenge nonce, sign it with
   the Apollo key from the Codex vault and return the signature. **REUSE the existing
   `src/routes/verify.tsx` redirect-sign flow** — add an Apollo-curve sibling, don't invent
   new infra.
4. **Surface the baked Apollo PUBLIC key** — a copy-to-clipboard affordance in the Apollo
   Account view so the operator can paste `apollo-public` into their consumer's build.

The Apollo **seed never leaves the Codex**. Pythia stays keyless. The user can NEVER
self-activate — only the hub Cronoton flips `activated=true`, after Pythia verifies the
signature AND the 250 STOA payment is confirmed. That two-party gate is why activation is a
ping-pong (redirect out to sign → back → hub flips).

---

## 1. Ground truth — what already exists in OuronetUI (files I read)

### 1a. Apollo creation + the experimental gate
- **`src/lib/dalos/registry.ts`** — `getOuronetRegistry(experimentalCurvesEnabled)`. When the
  flag is ON it does `registry.register(Apollo)` (from `@stoachain/stoa-core/dalos`); when OFF,
  Apollo isn't even loaded. Exports `APOLLO_PRIMITIVE_ID = "dalos-apollo"`,
  `DALOS_GENESIS_PRIMITIVE_ID = "dalos-gen-1"`, and `primitiveIdForCurve("dalos"|"apollo")`.
  **Its header comment is the exact restriction to relax:** *"APOLLO accounts are
  observational — spawn, reveal, export, but no on-chain activation or signing."*
- **`src/hooks/use-ouro-api.tsx`** — `useOuroApi()`. Reads
  `state.wallet.uiSettings.experimentalCurvesEnabled`, picks the registry, and exposes
  `generateOuronetAccount(mnemonic, password, isSmart?, primitiveId?)` and
  `generateOuronetAccountByMode(options, isSmart?)`. Pass `primitiveId: "dalos-apollo"` (or
  `options.primitiveId`) to mint an Apollo account. **Currently these throw/return `undefined`
  unless `experimentalCurvesEnabled` is true** (registry has no Apollo primitive registered).
- **`src/redux/slices/walletsSlice.ts`** — the flag lives on
  `uiSettings.experimentalCurvesEnabled` (default `false`), toggled via `setUiSettings(...)`.
- **`src/lib/dalos/originCurve.ts`** — `detectOriginCurve(account)`; `OuronetOriginCurve =
  "dalos" | "apollo"`; `APOLLO_PREFIXES = ["₱.", "Π."]`. Sniffs the address prefix when
  `account.originCurve` is absent (legacy).
- **`src/lib/dalos/useAutoEnableExperimentalCurves.ts`** — one-shot effect (called in
  `App.tsx`) that flips the flag ON at boot if any stored account has `originCurve === "apollo"`.
- **`src/ouro.d.ts`** — `IOuroAccount`: `publicKey` is *"the base-49 prefixed `{len}.{xy}`
  `FullKey.keyPair.publ`"* → **for an Apollo account this `publicKey` IS the `₱./Π.` Apollo
  public key** = the on-chain `apollo-public` registry key = the value to bake. `originCurve?:
  OuronetOriginCurve`, `originMode?`, `secret` (encrypted seed material), `isActive?`,
  `chainPublicKey?` (live from the 80s sync).
- **`src/context/auth-context.tsx`** — where accounts are spawned on codex creation
  (`generateOuronetAccount(mnemonic, password, false)`, `isSmart:false`). This is where a
  curve choice would be threaded.

### 1b. "Activate Ouronet Account" — the modal to MIRROR
- **`src/components/settings/ActivateStandardAccountModal.tsx`** — CFM Architecture v2 ZBOM
  modal. Study this as your template:
  - Pulls interaction info from **`@stoachain/ouronet-core/interactions/activateFunctions`**
    (`getDeployStandardAccountInfoOnly`, `getDeployStandardAccountInfo`) and builds Pact via
    **`buildDeployStandardAccountPactCode`** (`@stoachain/ouronet-core/pact`).
  - Signs+submits through **`useCFMStrategy().execute({ build, guards, paymentKey,
    resolvedForeignKeys })`** (`@/lib/signing/useCFMStrategy`) — gas-payer key carries
    `DALOS.GAS_PAYER` + N `coin.TRANSFER` caps; STOA cost comes from the INFO call
    (`fullInfo.info.kadena["kadena-full"]`, split across `receivers`/`amounts`).
  - UI scaffolding to copy: `ZbomLayout`, `FunctionInfoZone`, `Zone2Wrapper`,
    `StringEntryInput`/`GuardEntryInput` (`@/components/cfm/...`), the Auto/manual `Switch`,
    the signer-readiness rows, the STOA-balance guard.
- **Trigger buttons** ("Activate Ouronet Account" / "Activate Ouro Account") live in:
  - `src/components/dashboard/DashboardInfoHeader.tsx` (Zone 5 "Basic Controls",
    `firstInactive` account, `setActivateOpen(true)`).
  - `src/components/core/HeaderAccountWidget.tsx` (per-account "activate badge",
    `handleActivateBadge`).
  - `src/components/home/overview.tsx` (the "Account Activation Required" card,
    `setActivationModalOpen(true)`, cost pulled the same way).

### 1c. The HUB redirect-sign flow to REUSE
- **`src/routes/verify.tsx`** — `/verify` — **this is the proven mechanism the spec says to
  reuse.** The AncientHoldings hub deep-links `?account&challenge&callback`. It:
  1. reads the account from the unlocked Codex (`useWallet().ouro`),
  2. decrypts `acct.secret` with the cached password (`getCurrentPassword` + `smartDecrypt`),
  3. re-derives the full keypair via `deriveFullKey(originMode, secret)` →
     `createOuronetAccount(registry, ...)`,
  4. **sanity-checks** the re-derived address equals the requested account,
  5. **signs the canonical challenge** with `schnorrSign(full.keyPair, buildChallengeMessage(...))`,
  6. redirects to `callback?challenge=<nonce>&signature=<sig>` (or shows the sig to copy if no
     callback).
  **The private key never leaves the browser; only the signature travels.** `buildChallengeMessage`
  is byte-identical to the hub's `lib/account-verification/canonical-message.ts`.
  **Caveat baked into `verify.tsx` today:** it hardcodes `getOuronetRegistry(false)` (DALOS-only)
  and comments *"Verification only targets Standard Ouronet (Ѻ.) accounts, which are always
  DALOS Genesis."* Your Apollo sibling MUST use the Apollo registry + Apollo signer instead.
- **`src/routes/verify-stoa.tsx`** — `/verify-stoa` — the Ed25519/Kadena sibling (`?address&msg&
  callback`). Same redirect-sign shape, different curve. Confirms the pattern is already
  duplicated per curve — you're adding a third sibling for Apollo.

---

## 2. Deliverable 1 — Un-gate Apollo Account creation

**Goal:** an operator can create an Apollo Account **without** flipping an "experimental" switch,
and that account is no longer marked "observational / cannot sign".

**Do:**
1. **Make the Apollo primitive always available.** In `src/lib/dalos/registry.ts`, register
   `Apollo` unconditionally (or add a dedicated `getPythiaRegistry()` that always includes it).
   Keep `experimentalCurvesEnabled` only if you still want it to gate the *broad* experimental
   curve selector; Pythia-key creation must not depend on it. Simplest: register Apollo in the
   default registry and retire the toggle-gated branch.
2. **Update the registry/`ouro.d.ts` comments** that assert Apollo is "observational only — no
   on-chain activation or signing." For the Pythia lane that is now false: Apollo accounts ARE
   placed on-chain (inactive) and DO sign the activation challenge. Keep the accurate part:
   Apollo accounts do **not** transact as general Ouronet accounts (they're not Ѻ./Σ. accounts
   for token ops) — they exist to be Pythia API keys.
3. **Expose an explicit "Create Apollo Pythia API Key" entry point.** Rather than repurpose the
   generic curve selector, add a dedicated action (button/modal) that calls
   `useOuroApi().generateOuronetAccount(mnemonic, password, /*isSmart*/ false,
   primitiveIdForCurve("apollo"))` (or `generateOuronetAccountByMode({ ..., primitiveId:
   "dalos-apollo" })`), stores the result with `originCurve: "apollo"` and the seed encrypted in
   `secret` (same storage path as any Codex account), and surfaces the resulting `publicKey`
   (the `₱./Π.` key) for Deliverable 4. Place this in the Apollo Account view (see D2).
4. **Do NOT weaken the general "observational" guard for non-Pythia experimental curves** if any
   other curve depends on it — scope the un-gate to Apollo + the Pythia flow.

**Guardrails:**
- The seed lives ONLY in the Codex (`acct.secret`, encrypted). Never surface the seed to any
  network call. Only `publicKey` is ever copied/baked/sent.
- Auto-enable (`useAutoEnableExperimentalCurves`) can stay; it becomes harmless once Apollo is
  always registered.

---

## 3. Deliverable 2 — "Activate Apollo Pythia API Key" (Deploy, pays 250 STOA)

**Goal:** a per-Apollo-account action that puts the key on-chain **inactive** by calling
`DeployApolloPythiaApiKey`, charging **250 STOA** from the operator's Ouronet account to the
treasury. This is the **anti-abuse paywall** — there is NO per-account key limit. If the operator
can't later prove ownership, they simply forfeit the 250 STOA and the key never turns on.

**Build `src/components/settings/ActivateApolloPythiaKeyModal.tsx`** — a near-clone of
`ActivateStandardAccountModal.tsx`:
- **Info + Pact code:** use the Apollo-key analogues of `activateFunctions` /
  `buildDeployStandardAccountPactCode`. These come from the **DALOS/hub agent's** module work —
  expect `@stoachain/ouronet-core/interactions` to gain a `getDeployApolloPythiaKeyInfo(...)`
  (returns the 250 STOA cost + receiver(s), same shape `ActivateStandardAccountModal` consumes:
  `info.kadena["kadena-full"]`, `receivers`, `amounts`) and
  `@stoachain/ouronet-core/pact` to gain `buildDeployApolloPythiaKeyPactCode({ apolloPublic,
  consumerLane, ownerAccount })`. **Open item — coordinate exact names/signatures with the
  DALOS/hub handoff** (`DeployApolloPythiaApiKey` in the new `pythia-consumer-keys` module,
  spec §6).
- **Inputs (mirror the ZBOM zones):**
  - `apollo-public` = the Apollo Account's `publicKey` (autonomous, read-only).
  - `consumer-lane` = a short label the operator types (e.g. `"aletheia"`, `"my-dapp"`) →
    on-chain `consumer-lane`. Optionally offer `UpdateApiConsumerName` later (spec §Optional).
  - `owner-account` = the paying Ouronet account (`ouroAccount.address`) → on-chain
    `owner-account`.
- **Payment:** reuse the exact `useCFMStrategy().execute({ build, paymentKey, ... })` pattern —
  gas-payer key carries `DALOS.GAS_PAYER` + the `coin.TRANSFER` cap(s) that move **250 STOA**
  owner→treasury. Show the same balance guard (`hasEnoughStoa`) with the 250 figure from the
  INFO call (don't hardcode 250 in the UI — read it from info so the governance knob stays live).
- **Result:** on submit success, the row is on-chain with `activated=false`. Toast + set the
  account's local state to "registered · inactive". **Make it explicit in copy** that the key is
  NOT live yet and requires the ownership-proof step (D3).

**Trigger placement (mirror D1b):** add an "Activate Apollo Pythia API Key" button in the Apollo
Account view (the same surface where the general "Activate Ouronet Account" button lives — a new
Apollo-specific card/badge in `DashboardInfoHeader.tsx` / `HeaderAccountWidget.tsx`, or a
dedicated Apollo section). Gate it: only show for accounts with `originCurve === "apollo"`, and
show "Deploy (250 STOA)" when no on-chain row exists vs. "Registered · awaiting activation" once
it does.

**Hard rule:** Deploy is USER-called and only registers + pays. It **never** sets
`activated=true`. Do not add any UI that lets the user self-activate — that's admin-capped on the
hub (see D3).

---

## 4. Deliverable 3 — Ownership-proof handshake (REUSE `/verify`, add an Apollo sibling)

**Goal:** when Pythia deep-links with a challenge nonce, OuronetUI signs it with the Apollo key
from the Codex vault (wallet unlocked) and returns ONLY the signature. Pythia runs
`Apollo.verify(sig, nonce, pubkey)` and, on success + confirmed 250 STOA payment, instructs the
hub Cronoton to flip `activated=true`.

**Build `src/routes/verify-apollo.tsx`** — a sibling of `src/routes/verify.tsx`, same skeleton,
Apollo curve:
- **Deep-link params:** accept Pythia's link. Mirror `verify.tsx`'s
  `?account&challenge&callback` (Pythia mints the nonce as `challenge`, passes a `callback` back
  to Pythia). Confirm the exact param names with the Pythia handoff before shipping; keep
  OuronetUI's parser tolerant.
- **Find the Apollo account:** locate it in the unlocked Codex by `apollo-public` (the
  `publicKey`) — Pythia knows the pubkey it wants activated, so it's cleaner to key on
  `publicKey` than on address. Fall back to `address` if Pythia sends that.
- **Re-derive + sign (the whole point):**
  - `getCurrentPassword()` → `smartDecrypt(acct.secret, password)` (same as `verify.tsx`).
  - Re-derive the FullKey with the **Apollo registry**:
    `createOuronetAccount(getOuronetRegistry(true) /* or the always-Apollo registry from D1 */,
    { mode: acct.originMode ?? "seedWords", data: ... })`. **Do NOT reuse `verify.tsx`'s
    hardcoded `getOuronetRegistry(false)`** — that's DALOS-only and will derive the wrong key.
  - **Sanity-check:** the re-derived Apollo public key must equal the requested `apollo-public`
    (mirror `verify.tsx`'s `full.standardAddress === account` guard, but compare on the Apollo
    pubkey). If not → error "correct Codex not unlocked".
  - **Sign the nonce with Apollo**, not `schnorrSign`. `schnorrSign` is the DALOS-Genesis signer;
    Apollo is a distinct 1024-bit primitive. Use the Apollo signer from
    `@stoachain/stoa-core/dalos` (the `Apollo` primitive's `sign`, or the registry's
    curve-appropriate sign path). **Open item — confirm the exact Apollo sign export with the
    Dalos-crypto owner; the spec (§9 Open) flags an empirically-unconfirmed `generateFromSeedWords
    → sign → verify` round trip. Validate that round trip against `Apollo.verify` before shipping.**
  - **What to sign:** sign the raw nonce Pythia issued (or a canonical challenge message if Pythia
    specifies one — coordinate the exact bytes with the Pythia handoff, exactly as `verify.tsx`
    keeps `buildChallengeMessage` byte-identical with the hub). Whatever the format, it MUST match
    what Pythia feeds `Apollo.verify`.
- **Return the signature:** redirect to `callback?challenge=<nonce>&signature=<sig>` (mirror
  `verify.tsx` — trailing-`?` vs `&` handling, `encodeURIComponent`). If no callback, show the sig
  to copy (fallback UI already exists in `verify.tsx` — reuse it verbatim).
- **UI:** reuse `verify.tsx`'s card layout and phase state machine
  (`idle→signing→redirecting→signed→error`) verbatim; change the copy to
  "AncientHoldings · Pythia API key activation" and reference the `₱./Π.` key.

**Route registration:** add `/verify-apollo` wherever `/verify` and `/verify-stoa` are registered
(check `src/App.tsx` / the router config — same place those two routes are wired).

**Hard rules (from spec §5):**
- The seed/private key **never** reaches Pythia. Signing happens only in this route, in-browser.
  Only the signature travels.
- OuronetUI does **not** flip `activated`. It returns a signature; the hub Cronoton (module-admin
  keyset) does the flip after Pythia verifies. The user cannot self-activate even though their
  seed is in their own Codex — that ping-pong is by design.

---

## 5. Deliverable 4 — Surface the baked Apollo PUBLIC key

**Goal:** the operator can copy the Apollo **public** key to paste into their consumer's build
(where it's baked as the Pythia request-header key). Permaweb-safe because Pythia is keyless — a
leaked public key can only burn that lane's rate budget, never move funds.

**Do:** in the Apollo Account view, add a labeled, copy-to-clipboard field showing
`account.publicKey` (the `₱./Π.` `{len}.{xy}` string). Copy text like: *"Bake this Apollo PUBLIC
key into your consumer build; the Codex forwards it as the Pythia key header. Never ship the
seed."* Optionally show activation status next to it (Inactive → Registered → Active, once the
80s sync surfaces the on-chain `activated` bool via the Pythia registry read — that read is a
Pythia/hub deliverable, spec §7 Pythia).

**Note for the Codex agent (cross-repo, not your task but flag it):** the Codex reads this baked
public key and sends it as the Pythia request header (`createPythiaConnection` already exists per
spec §7). You only need to make the public key easy to copy out.

---

## 6. Files to create / change (checklist)

**Create:**
- `src/components/settings/ActivateApolloPythiaKeyModal.tsx` — clone of
  `ActivateStandardAccountModal.tsx`; calls `DeployApolloPythiaApiKey` (250 STOA); inputs
  `apollo-public`, `consumer-lane`, `owner-account`.
- `src/routes/verify-apollo.tsx` — clone of `src/routes/verify.tsx`; Apollo registry + Apollo
  signer; returns signature to Pythia's callback.

**Change:**
- `src/lib/dalos/registry.ts` — register Apollo unconditionally (or add always-Apollo registry);
  fix the "observational only" comment.
- `src/ouro.d.ts` — update the `OuronetOriginCurve` "apollo" doc: on-chain-inactive-registerable +
  signable for the Pythia lane; not a general transacting account.
- Apollo Account view surface(s) — `src/components/dashboard/DashboardInfoHeader.tsx` and/or
  `src/components/core/HeaderAccountWidget.tsx` and/or a new Apollo card: add the "Create Apollo
  Pythia API Key" (D1), "Activate Apollo Pythia API Key" (D2), and copy-public-key (D4)
  affordances, gated on `originCurve === "apollo"`.
- Router config (where `/verify` + `/verify-stoa` are registered) — add `/verify-apollo`.
- `src/context/auth-context.tsx` (only if you thread Apollo creation through the codex-creation
  path rather than a standalone modal).

**Depends on (other repos — coordinate, don't stub blindly):**
- **DALOS/hub agent:** the `pythia-consumer-keys` Pact module (spec §6), `DeployApolloPythiaApiKey`
  (user-capped, 250 STOA), admin-capped `TurnApiOn`/`TurnApiOff` (Cronoton only), and the
  `@stoachain/ouronet-core` `interactions` + `pact` builders your modal imports. The 250 STOA
  figure MUST come from the INFO call, not a UI literal.
- **Pythia agent:** the challenge/redirect contract (param names for `verify-apollo`, the exact
  bytes to sign, the callback shape) and `Apollo.verify` input encoding.
- **Dalos-crypto owner:** the exact Apollo `sign` export and a confirmed
  `generateFromSeedWords → sign → Apollo.verify` round trip (spec §9 Open).

---

## 7. Hard rules to honor (non-negotiable, from spec §5)

1. **Seed never leaves the Codex.** All Apollo signing is in-browser in `verify-apollo.tsx`; only
   the signature is sent. No path sends `acct.secret` anywhere.
2. **OuronetUI never flips `activated`.** Deploy only registers + pays 250 STOA (inactive).
   Activation is admin-capped on the hub Cronoton, after Pythia verifies the signature AND the
   payment. No self-activation UI.
3. **Only the PUBLIC key is baked/copied/sent.** `account.publicKey` (`₱./Π.`), never the seed.
4. **250 STOA is the paywall, not a limit.** No per-account key cap in the UI. Read the amount
   from the INFO call so the governance knob stays live.
5. **Reuse, don't reinvent.** `verify-apollo.tsx` mirrors `verify.tsx`; the modal mirrors
   `ActivateStandardAccountModal.tsx`. Same UX, same signing strategy, Apollo curve.

---

## 8. Open questions for the OuronetUI agent

1. **Signer surface:** does `@stoachain/stoa-core/dalos` expose an Apollo `sign` today, or only
   `schnorrSign` (DALOS-Genesis)? If Apollo signing isn't wired, that's a blocking dependency on
   the Dalos-crypto owner — confirm the export + run the `sign → Apollo.verify` round trip before
   building `verify-apollo.tsx`.
2. **Where does the Apollo Account view live?** Standard accounts show Activate in
   `DashboardInfoHeader` / `HeaderAccountWidget` / `overview`. Is there a distinct Apollo-account
   surface, or do Apollo accounts appear in the same account list (gated by `originCurve`)? Decide
   whether to add an Apollo card vs. extend the existing account rows.
3. **Deploy interaction names:** confirm the final `getDeployApolloPythiaKeyInfo` /
   `buildDeployApolloPythiaKeyPactCode` (or however the DALOS/hub agent names them) and their
   arg shapes, so the modal imports match.
4. **Challenge param contract:** lock the `verify-apollo` deep-link param names and the exact
   bytes-to-sign with the Pythia agent (does Pythia send a raw nonce as `challenge`, or a
   canonical message? does the callback carry `challenge`+`signature` like `verify.tsx`?).
5. **Should general Apollo creation stay behind `experimentalCurvesEnabled`** for non-Pythia use,
   with only the Pythia-key flow un-gated — or is Apollo now fully un-gated everywhere? (Spec says
   un-gate; confirm scope with the owner so you don't accidentally expose observational Apollo
   accounts elsewhere.)