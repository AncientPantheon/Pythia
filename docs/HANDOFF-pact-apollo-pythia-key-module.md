# Handoff: `APIARY` — Apollo Pythia API-Key registry (new Ouronet/DALOS Pact module)

> **WARNING: cross-component interfaces are SETTLED in [HANDOFF-consumer-key-INTERFACES.md](HANDOFF-consumer-key-INTERFACES.md).** Where naming or any inter-component contract in this doc differs from that ICD - module/read names, the paid field, the redirect-sign return leg, the verifier->Cronoton HMAC envelope, or the activation cap/keyset - **the ICD wins.**

**Audience:** the OuronetPact implementing agent (you know Pact + the Ouronet module
conventions cold). This describes **WHAT to build and WHY**, in your house style — it
is **not** finished Pact code. Name the functions/schemas/caps per the patterns below;
write the bodies yourself.

**Author:** Pythia agent (Claude Opus, 2026-07-08), grounded by reading the real deployed
`CODEX` core module (`1_SOVEREIGN/STAGE_01/2_Core/22_CODEX.pact`), its Talos client
`TS01-C4` (`.../3_Talos/06_TS01-C4.pact`), `DALOS` (`.../2_Core/01_DALOS.pact`), the
`U|DALOS` glyph utility (`.../1_Utilities/08_U_DALOS.pact`), and `IGNIS`'s native-STOA
collector (`.../2_Core/02_IGNIS.pact`).

**Canonical spec (read first, it is the source of truth):**
`Pythia/docs/PYTHIA-CONSUMER-KEY-MODEL.md`. Every decision below traces to it. Where this
handoff and the spec ever disagree, the spec wins — flag it, don't silently diverge.

**Status:** design-locked at the spec level; implementation not started. This is a **new,
opt-in lane** that **coexists** with Pythia's current shared-secret connector store — it is
**not** a rewrite of anything.

---

## 0. TL;DR of the whole module

One Pythia API key **is** an on-chain **Apollo Account** — identified by its `₱.` (Standard)
or `Π.` (Smart) Apollo public-key string (162-char, `U|DALOS` charset). This module is a
tiny registry table keyed on that Apollo public string, with:

- **`DeployApolloPythiaApiKey`** — USER-called. Charges **250 STOA** (patron → Ouronet
  treasury, the anti-abuse paywall), inserts the row `activated=false`, records the owner
  Ouronet account + a consumer/lane name. **There is NO per-account key limit** — the 250
  STOA is the only gate. If a user deploys a key they can't prove ownership of, they simply
  burn the 250 STOA and it never turns on.
- **`TurnApiOn` / `TurnApiOff`** — **ADMIN/Cronoton-capped ONLY**. Only the HUB "Codex
  Cronoton" (module-admin keyset) may flip the `activated` boolean. The user **cannot**
  self-activate. This asymmetry (user deploys+pays, only admin flips) is exactly why
  activation is a **ping-pong**: pay on-chain → prove Apollo ownership off-chain to Pythia →
  Pythia instructs the Cronoton → Cronoton flips the bit.
- **`UpdateApiConsumerName`** (optional) — rename a lane against a price.
- **Free `UR_` read accessors** Pythia calls via `/local` (`signers:[]`, `sigs:[]`, no gas,
  no key): is-activated, full row, list-all + count.

Pythia stays **keyless + fund-less**: it verifies Apollo signatures off-chain (Pact cannot
verify Apollo-curve sigs), reads this table via `/local`, and *instructs* the Cronoton. It
never signs a chain tx, holds no key, and never touches the 250 STOA (that's a user→treasury
tx this module performs directly).

---

## 1. Why this module exists (the ping-pong, in one paragraph)

Pact **cannot** verify an Apollo-curve signature on-chain (Apollo is a custom
Twisted-Edwards/Schnorr scheme; Pact only does ED25519/WebAuthn). So ownership of an Apollo
key can only be proven to an **off-chain verifier that has Dalos crypto** — that's Pythia.
But Pythia is deliberately keyless and cannot write to chain. So the flow must be a relay:
the user **pays 250 STOA + deploys the inert row themselves** (a normal Ouronet-account tx
the chain *can* authorize), then proves Apollo ownership to Pythia off-chain, and Pythia tells
the **HUB Codex Cronoton** (which holds this module's admin keyset) to flip `activated=true`.
The user is in the Codex key-vault with the seed — but the seed **never** leaves; only a
signature over a Pythia-issued nonce travels. This is the same redirect-and-sign handshake the
HUB already uses to verify Ouronet accounts, reused for the Apollo key.

Consequence for you: **deploy/pay must be user-capped** (owner ownership + a real STOA
transfer), **on/off must be admin/Cronoton-capped** (a module-admin keyset), and the two must
be **separate defuns with separate capabilities**. Do not let the deploy path flip the bit,
and do not let the owner's guard satisfy the on/off cap.

---

## 2. Ground rules from the deployed conventions (follow these exactly)

Read `OuronetInformational/MODULE_ARCHITECTURE.md` for the canonical nomenclature; the live
`CODEX` module is your closest structural template (registry table + admin insert + owner cap
+ cost-gated client op wired one layer up in Talos). Key patterns you MUST mirror:

**Module skeleton.** `(interface ApiaryV1 ...)` then `(module APIARY GOV ...)`.
`(implements ApiaryV1)` + `(implements OuronetPolicyV1)`. Governance block:
- `(defconst GOV|MD_APIARY (keyset-ref-guard (GOV|Demiurgoi)))` — Demiurgoi master keyset.
- `(defcap GOV () (compose-capability (GOV|APIARY_ADMIN)))`
- `(defcap GOV|APIARY_ADMIN () (enforce-guard GOV|MD_APIARY))`
- `(defun GOV|Demiurgoi () (let ((ref-DALOS:module{OuronetDalosV1} DALOS)) (ref-DALOS::GOV|Demiurgoi)))`
- `(defun GOV|NS_Use () (let ((ref-U|CT:module{OuronetConstantsV1} U|CT)) (ref-U|CT::CT_NS_USE)))`

**The Cronoton admin keyset.** Mirror how `CODEX` names its dedicated operator keyset
(`GOV|CodexKey () = (+ (GOV|NS_Use) ".codex-keyset")` guarded by `CODEX|ADMIN`). Define your own:
- `(defun GOV|CronotonKey () (+ (GOV|NS_Use) ".apiary-cronoton-keyset"))` (final keyset name
  is the owner's call — see §11).
- `(defcap APIARY|CRONOTON () (enforce-guard (keyset-ref-guard (GOV|CronotonKey))))`
This keyset is what the HUB Codex Cronoton signs with to flip `activated`. It is DISTINCT from
`GOV|MD_APIARY` (Demiurgoi) — Demiurgoi governs the module code + prices; the Cronoton keyset
is the day-to-day activation flipper. (You may let Demiurgoi also satisfy on/off as a
break-glass via `enforce-one`, owner's call — but the Cronoton keyset is the normal path.)

**Function-name prefixes (house style — use them):**
- `UC_` pure compute/helpers · `UR_` table reads (the `/local` accessors Pythia calls) ·
  `URC_` read+compute · `UEV_` enforce-validate · `UDC_` object/row constructors ·
  `A_` admin-gated entrypoints · `C_` client (user) entrypoints · `XI_` internal write-only
  (guarded by `require-capability (SECURE)`).
- Table = `APIARY|T|<Name>`, schema = `APIARY|S|<Name>`, event/validation caps =
  `APIARY|A>…` (admin), `APIARY|C>…` (client), plus `APIARY|OWNER`, internal `SECURE`.

**The capability-then-write split (this is the load-bearing idiom in `CODEX`).** Every
mutating entrypoint does: `(UEV_IMC)` (inter-module-caller policy check) → `(with-capability
(APIARY|C>… / APIARY|A>…) (XI_Write …))`. ALL validation + `compose-capability (SECURE)` lives
**inside the `defcap`**; the `XI_` writer does `(require-capability (SECURE))` then a bare
`insert`/`update` — **no logic in the writer**. Copy this shape; reviewers expect it.

**Policy plumbing.** Copy `CODEX`'s `P|T`/`P|MT` deftables, `P|CODEX|CALLER`-style caller cap,
`P|Info`/`P|UR`/`P|A_Add`/`P|A_AddIMP`/`P|A_Define`/`UEV_IMC` verbatim (rename `CODEX`→`APIARY`).
This is boilerplate that gates who may invoke the module; do not invent your own.

**Apollo glyph validation is already written for you** — reuse `U|DALOS`:
`GLYPH|UEV_ApolloAccountCheck account smart:bool` (bool, no enforce) and
`GLYPH|UEV_ApolloAccount account smart:bool` (enforcing). Standard `₱.` → `smart=false`, Smart
`Π.` → `smart=true`; both are 162-char with a `.` second char and `DALOS|CHARSET` body. Do NOT
re-implement glyph checks. (`ref-U|DALOS:module{UtilityDalosGlyphsV2} U|DALOS`.)

---

## 3. The table

One table, keyed on the Apollo public string (the key itself). Schema
`APIARY|S|ApiKey` in `deftable APIARY|T|ApiKeys:{APIARY|S|ApiKey}` — **Key = `apollo-public`**.

Fields (name them in house style; `;;[.]` = immutable-after-insert, `;;[M]` = mutable):

| field | type | notes |
|---|---|---|
| `apollo-public` | `string` | `;;[.]` The `₱.`/`Π.` 162-char Apollo public key. Repeated as a field (like `CODEX`'s `codex-id`) for in-row reads; also the table key. This is the exact string Pythia feeds to `Apollo.verify` off-chain and bakes into consumer builds. |
| `consumer-lane` | `string` | `;;[M]` Attribution label / lane name, e.g. `ouronetui`, `aletheia`. Mutable only via `UpdateApiConsumerName`. Validate with a name check (see §7). |
| `activated` | `bool` | `;;[M]` **The switch.** Inserted `false` by deploy; flipped ONLY by the Cronoton cap. |
| `owner-account` | `string` | `;;[.]` The **Ouronet DALOS account** (`Ѻ.*`/`Σ.*`) that deployed + paid for the key. This is the on-chain identity that owns the lane (NOT the Apollo key itself, which is the *product* being registered). |
| `is-standard` | `bool` | `;;[.]` `true` if the Apollo key is Standard `₱.`, `false` if Smart `Π.` — captured at insert so reads/`Apollo.verify` know which half. (Derivable from the first glyph, but storing it is cheaper for the reader and matches `CODEX` denormalization habits.) |
| `registered-at` | `time` | `;;[.]` `(at "block-time" (chain-data))` at deploy. |
| `updated-at` | `time` | `;;[M]` Bumped on every mutation (activate/deactivate/rename). |

**Optional soft-binding fields** (only if the owner wants origin binding on-chain rather than
in Pythia's config — the spec §4 lists it as *optional hardening*; default is Pythia-side, so
prefer to **omit** these unless the owner asks):
- `origins:[string]` `;;[M]` allowed origins for soft binding; Pythia enforces `Origin`/`Referer`.

Keep the schema this small. The spec is explicit: **no per-key request counter on-chain**
(usage stays "Pythia meters, hub mints" aggregate; never per-request writes). Do not add a
`request-count` / `last-used` field.

Add the usual sentinel constants like `CODEX` does:
`(defconst APIARY|EPOCH:time (time "1970-01-01T00:00:00Z"))` and
`(defconst APIARY|APOLLO-LEN:integer 162)`.

---

## 4. `DeployApolloPythiaApiKey` — user-called, 250 STOA, inserts inactive

**Intent:** any Ouronet-account holder registers an Apollo public key as an inert Pythia lane,
paying the 250 STOA anti-abuse toll. No admin involved. No proof of Apollo ownership yet — an
unowned key just sits inert forever and the 250 STOA is forfeit.

**Signature (core module, `C_`-prefixed):**
`(defun C_DeployApolloPythiaApiKey:string (owner-account:string apollo-public:string is-standard:bool consumer-lane:string) …)`

**Cap `APIARY|C>DEPLOY-API-KEY` must enforce, before any write:**
1. **Owner controls `owner-account`** — `(compose-capability (APIARY|OWNER owner-account))`
   where `APIARY|OWNER` does `(ref-DALOS::CAP_EnforceAccountOwnership owner-account)` (exactly
   how `CODEX|STOICTAG-DALOS-OWNER` composes DALOS ownership). This proves the payer authorized
   the tx and is a real Ouronet account.
2. **`apollo-public` is a well-formed Apollo string** —
   `(ref-U|DALOS::GLYPH|UEV_ApolloAccount apollo-public is-standard)`. This enforces `₱.`/`Π.`
   prefix + length 162 + charset. It does **NOT** prove ownership (impossible on-chain) — just
   shape. Ownership is proven off-chain later (§9).
3. **`consumer-lane` name is valid** — reuse the StoicTag name check (`UC_IzStoicTagName` /
   `UEV_StoicTagName` in `U|DALOS`) or a simpler ANC check; pick one and document it.
4. `(compose-capability (SECURE))` for the `XI_` writer.
5. **Uniqueness** is enforced for free by Pact `insert` on the key — a second deploy of the
   same `apollo-public` throws (collision). Good: one row per key.

**The 250 STOA charge — DO THIS LIKE THE DEPLOYED CODE, NOT `coin.transfer`.** The Ouronet
stack does **not** use raw `coin.transfer` for in-ecosystem fees; that was a placeholder in the
old Mnemosyne draft. Two real patterns exist; pick per §11 with the owner:

- **(A) Native-STOA collection (the StoicTag precedent, RECOMMENDED).** `CODEX` charges
  StoicTags by having its **Talos client** `TS01-C4` call
  `(ref-IGNIS|V2::KDA|C_CollectWTEx patron account-address stoa-fee false)` — this pulls
  **native STOA from the payer's Kadena konto** and splits it 10/20/30/40 to the Demiurgoi
  treasury accounts (Demiourgos.Holdings, Ouronet Maintenance, KDA-Ouroboros, KDA-Dalos
  gas-station) via `C_TransferDalosFuel`. If the 250 STOA is meant as an ecosystem fee (it is —
  "transfer from the owner Ouronet account to a treasury"), this is the idiomatic path. The
  **core `APIARY` module stays fee-free and write-only**; the STOA collection is wired **one
  layer up in a Talos client** (see §6), exactly as `CODEX|C_RegisterStoicTag` does.

- **(B) Single-treasury DPTF transfer.** If the owner wants the 250 STOA to land in **one named
  treasury SC account** (not gas-split), use the DPTF true-fungible transfer the way `DEMIPAD`
  does: `(ref-TS01-C1::DPTF|C_Transfer patron <stoa-asset-id> owner-account <treasury-sc-name>
  250.0 true)`. The STOA asset id comes from a `DALOS` property accessor (see §11 — confirm
  whether "STOA" means the native `ur-stoa-id`/`silver-stoa-id`/`wrapped-stoa-id` DPTF token or
  native Kadena-layer STOA). This also belongs in the Talos client layer, not the core module.

Either way: **the core module never holds funds and never defines the treasury** — it exposes
`(defun UC_DeployPrice:decimal () 250.0)` (governance-tunable via an admin price setter if you
want, mirroring `DALOS|A_UpdateUsagePrice`) and the **Talos client collects the fee then calls
the core insert**. Keep the money out of the core registry.

**Writer `XI_InsertApiKey`** (`require-capability (SECURE)`): a single
`(insert APIARY|T|ApiKeys apollo-public { … "activated": false … })` built from a
`UDC_ApiKey` constructor, with `registered-at`/`updated-at` = block-time. That's it.

---

## 5. `TurnApiOn` / `TurnApiOff` — ADMIN/Cronoton-capped ONLY

**Intent:** flip the `activated` bit. This is the **only** privileged mutation, and it is the
crux of the whole ping-pong: **the user cannot call this even though they own the key and paid
for it.** Only the HUB Codex Cronoton (holding the Cronoton keyset) may.

**Signatures (admin-gated, `A_`-prefixed):**
- `(defun A_TurnApiOn:string (apollo-public:string) …)`
- `(defun A_TurnApiOff:string (apollo-public:string) …)`

**Cap `APIARY|A>SET-ACTIVATION` must:**
1. `(compose-capability (APIARY|CRONOTON))` — enforce the Cronoton keyset (§2). Optionally
   `enforce-one` the Demiurgoi admin as break-glass (`GOV|APIARY_ADMIN`). **Do NOT** compose
   `APIARY|OWNER` here — the owner must not be able to self-activate. This asymmetry is a
   REQUIREMENT, not an oversight.
2. Enforce the row exists (a `read`/`UR_` that throws on absent key, or an explicit
   `UEV_ApiKeyExists`).
3. Enforce the target boolean actually differs from current (like `DALOS|GOV|GAP`:
   `(enforce (!= new-state current) "already toggled")`) so no-op flips revert cleanly.
4. `(compose-capability (SECURE))`.

Model these as **two thin entrypoints** (`A_TurnApiOn` → state `true`, `A_TurnApiOff` → `false`)
both funneling to one writer `XI_SetActivation apollo-public state:bool` that does
`(update … { "activated": state, "updated-at": (block-time) })`. Emit an `@event` on the cap so
the Cronoton flip is observable on-chain (Pythia can watch it to refresh its cache faster). Add
`@doc` making explicit these are the **revocation** path too (`TurnApiOff` = revoke; spec §3d).

**Why admin-capped is safe + necessary:** the Cronoton only flips after Pythia has verified the
Apollo-ownership signature off-chain AND the 250 STOA deploy is on-chain. Locking the flip
behind the Cronoton keyset is what makes "user pays + proves, hub activates" enforceable —
otherwise anyone could self-activate an inert key and skip the proof. Keep the
Pythia→Cronoton trigger channel authenticated (spec §5 rule 3) — but that's the HUB agent's
job; on-chain you just gate on the keyset.

---

## 6. Where the fee wiring lives — a Talos client entrypoint (mirror `TS01-C4`)

Do **not** put `KDA|C_CollectWTEx` / `DPTF|C_Transfer` inside the core `APIARY` module. The
deployed pattern (`CODEX` core = write-only; `TS01-C4` = fee + call) is:

- **Core `APIARY.C_DeployApolloPythiaApiKey`** = validation + insert only (no money). Actually,
  to match `CODEX` most closely, the core client fn can be fee-free and the **Talos client**
  both collects STOA and calls it. Concretely, add (or extend an existing Stage-01 Talos client
  such as a new `TS01-C4`-sibling): `(defun APIARY|C_DeployApiKey (patron owner-account
  apollo-public is-standard consumer-lane) …)` that, under `(with-capability (P|TS))`:
  1. computes `price = (ref-APIARY::UC_DeployPrice)` = 250.0,
  2. calls `(ref-APIARY::C_DeployApolloPythiaApiKey owner-account apollo-public is-standard
     consumer-lane)` to insert the inert row,
  3. collects the 250 STOA: pattern (A) `(ref-IGNIS|V2::KDA|C_CollectWTEx patron owner-account
     price false)` **or** pattern (B) `DPTF|C_Transfer` to the treasury.
- Same for the optional rename (§7): the price is collected in the Talos layer, the core just
  does the `update`.

This keeps `APIARY` a clean keyless-readable registry and puts all fungible movement in the
Talos client where every other Ouronet fee lives. Register the module in the Talos client's
`P|A_Define` inter-module-policy list (copy how `TS01-C4` adds `CODEX`, `IGNIS`, `DALOS`,
`TS01-A` guards) so `UEV_IMC` passes.

---

## 7. `UpdateApiConsumerName` (optional) — rename a lane against a price

**Intent:** let the owner relabel their lane (`consumer-lane`) for a fee. Optional per the spec
("Optional: UpdateApiConsumerName(apollo-public, new-name) against a price"). Build it only if
cheap to include.

- Core: `(defun C_UpdateApiConsumerName:string (owner-account:string apollo-public:string
  new-name:string) …)`.
- Cap `APIARY|C>UPDATE-NAME`: `(compose-capability (APIARY|OWNER owner-account))` +
  enforce the row's `owner-account` equals `owner-account` (so only the deployer renames) +
  validate `new-name` (same name check as deploy) + `(compose-capability (SECURE))`.
- Writer `XI_UpdateName`: `(update … { "consumer-lane": new-name, "updated-at": block-time })`.
- Price: a `UC_RenamePrice` const, collected in the Talos client layer like §6. Governance-tunable.

This one is **owner-capped, not admin-capped** — renaming your own lane isn't a privileged
activation, it's an owner action, so `APIARY|OWNER` is correct here (contrast §5).

---

## 8. Free `UR_` read accessors — what Pythia calls via `/local`

These are the **whole point of the module for Pythia**: gasless, keyless, signature-free reads
Pythia issues as `/local` dirty reads (`signers:[]`, `sigs:[]`). Follow `CODEX`'s `UR_…` +
`…DataOrNull` idiom precisely.

Required:
- `(defun UR_IsActivated:bool (apollo-public:string))` — `(at "activated" (read APIARY|T|ApiKeys
  apollo-public ["activated"]))`. **The hot path** — Pythia's grant check reads this (cached,
  fail-open) as the first branch of `resolveConsumer`. Add an `-OrFalse` variant using
  `with-default-read` so an **unregistered key returns `false`** instead of throwing (Pythia
  must not crash on unknown keys):
  `(defun URC_IsActivatedOrFalse:bool (apollo-public:string))`.
- `(defun UR_ApiKeyRow:object{APIARY|S|ApiKey} (apollo-public:string))` — full row.
- `(defun UR_ApiKeyRowOrNull:object (apollo-public:string))` — like `CODEX`'s
  `UR_CIX|DataOrNull`: returns a sentinel object with `is-registered:false` (built by a
  `UDC_ApiKey|Unregistered` constructor) when absent, else the row `+ {"is-registered": true}`.
  Pythia uses this to render the public directory without try/catch.
- Field accessors as needed: `UR_ConsumerLane`, `UR_OwnerAccount`, `UR_IsStandard`,
  `UR_RegisteredAt`, `UR_UpdatedAt` (each a thin `(at "field" (read … [field]))`).

**List-all + count (the public directory).** Pythia is a *read engine* — it displays ALL
registered keys with their activation status regardless of the switch (spec §7, "public
directory"). Provide:
- `(defun UR_ListAllApiKeys:[object] (…))` — return every row. Two acceptable shapes; pick per
  §11:
  - **All rows via keys+map:** `(map (UR_ApiKeyRow) (keys APIARY|T|ApiKeys))` — full rows.
  - **Filtered via `select`:** `(select APIARY|T|ApiKeys (constantly true))` or a
    `where`-filtered activated-only variant `UR_ListActivatedApiKeys`.
  Note the same `select`/`keys` O(table-size) caveat `CODEX` flags for `UR_AWT|ListByCodex` —
  fine at expected scale; revisit if the table grows huge. Pythia caches this (~60s) so it's a
  cold path.
- `(defun URD_ApiKeyCount:string ())` / or `:integer` — mirror `DALOS|URD_AccountCounter`:
  `(length (keys APIARY|T|ApiKeys))`. Provide both a raw-integer count and a formatted string if
  you want to match the `URD_` "human string" precedent; Pythia only needs the number.

Consider a convenience `URC_ActivatedSet:[string]` returning just the activated `apollo-public`
strings — Pythia's cache mirror wants exactly this (the "activated set" the spec keeps naming).
Cheap and it saves Pythia filtering client-side.

**All reads must be pure `read`/`with-default-read`/`select`/`keys`** — no capability, no write,
so they succeed in a `/local` with empty signers. Do not gate reads behind `UEV_IMC` or any cap.

---

## 9. Capability / keyset design — the summary table

| Operation | Function | Capability | Who satisfies it | Why |
|---|---|---|---|---|
| Deploy + pay 250 STOA | `C_DeployApolloPythiaApiKey` (core) + `APIARY|C_DeployApiKey` (Talos) | `APIARY|C>DEPLOY-API-KEY` → composes `APIARY|OWNER owner-account` (`CAP_EnforceAccountOwnership`) + `SECURE` | The **owner** of the paying Ouronet account | User pays + registers; no admin. Ownership proves the payer; STOA is the paywall. |
| Turn on (activate) | `A_TurnApiOn` | `APIARY|A>SET-ACTIVATION` → composes `APIARY|CRONOTON` (Cronoton keyset), optional `enforce-one` Demiurgoi break-glass; **never** `APIARY|OWNER` | **HUB Codex Cronoton** only | Off-chain Apollo-proof + payment are gatekept by the Cronoton; user CANNOT self-activate → the ping-pong. |
| Turn off (revoke) | `A_TurnApiOff` | same `APIARY|A>SET-ACTIVATION` | Cronoton (or Demiurgoi admin) | Admin/owner-initiated revocation flows through the admin cap; `TurnApiOff` = revoke. |
| Rename lane | `C_UpdateApiConsumerName` | `APIARY|C>UPDATE-NAME` → `APIARY|OWNER owner-account` + row-owner match + `SECURE` | The owner who deployed | Owner action, not a privileged activation → owner-capped. |
| All `UR_` reads | `UR_*` | **none** | anyone (`/local`, keyless) | Keyless read engine; must work with empty signers. |
| Module upgrade / price setters | `GOV`, `A_Update*Price` | `GOV|APIARY_ADMIN` → `GOV|MD_APIARY` (Demiurgoi) | Demiurgoi master keyset | Standard Ouronet governance. |

**Keysets, concretely:**
- `GOV|MD_APIARY = (keyset-ref-guard (GOV|Demiurgoi))` — module code + prices (Demiurgoi).
- `APIARY|CRONOTON` enforces `(keyset-ref-guard (GOV|CronotonKey))` where
  `GOV|CronotonKey = (+ (GOV|NS_Use) ".apiary-cronoton-keyset")` — **the HUB Codex Cronoton's
  module-admin keyset; the switch-flipper.** Define this keyset in the deploy script before
  loading the module (mirror how the deploy defines `ouronet-ns.codex-keyset`).
- `APIARY|OWNER account` → `(ref-DALOS::CAP_EnforceAccountOwnership account)` — DALOS
  Standard/Smart ownership, reused not reinvented.
- `SECURE` — internal `true` cap; every `XI_` writer does `(require-capability (SECURE))`.

---

## 10. Tests the implementer must write (`.repl`, same dir; ~30+ cases)

Cover at least:

**Deploy (DEP-NN):** fresh deploy inserts row `activated=false` with all fields; duplicate
`apollo-public` deploy fails (insert collision); deploy by a non-owner of `owner-account` fails
(`APIARY|OWNER`); deploy with a malformed Apollo string fails (`GLYPH|UEV_ApolloAccount` — bad
prefix, wrong length, bad charset); `is-standard=true` requires `₱.` and `false` requires `Π.`;
`registered-at`/`updated-at` = block-time; 250 STOA actually collected/split (Talos-layer test
against the STOA sandbox); insufficient STOA balance fails the whole tx atomically (row NOT
inserted).

**Activation (ACT-NN):** Cronoton keyset turns a key on → `activated=true`, `updated-at`
bumped; **owner keyset (deployer) CANNOT turn on** (fails `APIARY|A>SET-ACTIVATION`); random
keyset cannot turn on; turn-on of an unregistered key fails (read); double turn-on (already
true) reverts (`!=` guard); `TurnApiOff` by Cronoton flips back to false (revocation); off-then-
on toggles cleanly; `@event` emitted on flip.

**Rename (REN-NN):** owner renames own lane → `consumer-lane` updated, other fields unchanged;
non-owner rename fails; rename of unregistered key fails; invalid new name fails; rename fee
collected.

**Reads (RD-NN):** `UR_IsActivated` true/false correct; `URC_IsActivatedOrFalse` returns
`false` for unregistered (no throw); `UR_ApiKeyRowOrNull` returns `is-registered:false`
sentinel for absent, real row+flag for present; `UR_ListAllApiKeys` returns all rows incl.
inactive ones; `URC_ActivatedSet` returns only activated keys; `URD_ApiKeyCount` correct after
N deploys; **all reads succeed in a `/local`-style call with no signers** (add an env with empty
keys and assert reads still pass — this is the property Pythia depends on).

**Governance (GOV-NN):** non-Demiurgoi cannot upgrade / cannot change prices; price setter by
Demiurgoi works; owner deployer's guard does NOT satisfy the activation admin cap (re-assert the
asymmetry as an explicit test — it's the whole security model).

Wire the `.repl` against the Stoa/STOA sandbox the other modules test against
(`REPL/…/[6.9]_CODEX.repl` is your closest reference harness; the STOA coin sandbox lives under
`00_StoaSandbox/` and `0_Stoa/`).

---

## 11. Closing notes — VERIFY these before writing (do not guess)

The archived `.pact` tree may have **drifted** from what's actually deployed on the Stoa chain.
Resolve each of these against the **deployed** modules (query `/local` or the deploy repo of
record), not just the archive:

1. **`₱./Π.` is confirmed the right key.** The spec locks it: a Pythia key = an Apollo Account's
   `₱.` (Standard) / `Π.` (Smart) public string, and `U|DALOS.GLYPH|UEV_ApolloAccountCheck`
   already validates exactly that (162-char, `₱`/`Π` prefix, `.` second char, `DALOS|CHARSET`).
   **Confirm** the deployed `U|DALOS` still exports `GLYPH|UEV_ApolloAccount` /
   `GLYPH|UEV_ApolloAccountCheck` with these signatures before you `implements`/reference them.
   Confirm which prefix your first real consumer (OuronetUI / Aletheia) actually bakes —
   Standard `₱.` vs Smart `Π.` — so `is-standard` defaults are right.

2. **Which "STOA" + which treasury.** The spec says "250 STOA … transfer from the owner Ouronet
   account to a treasury." Pin down with the owner:
   - Is "STOA" the **native Kadena-layer STOA** collected via `IGNIS.KDA|C_CollectWTEx` (the
     StoicTag precedent — splits 10/20/30/40 to the four Demiurgoi treasury konto), **or** a
     **DPTF true-fungible STOA token** (`ur-stoa-id` / `silver-stoa-id` / `wrapped-stoa-id` from
     `DALOS|PropertiesTable`) transferred to ONE named treasury SC via `DPTF|C_Transfer`?
   - If a single treasury: **which account** receives it (a Demiurgoi treasury, a new
     `APIARY|SC_NAME` smart account, or the HUB's account)? The spec §9 leaves the exact tx
     mechanics open; the owner decides. Default recommendation: **native-STOA collection (A)**,
     because it reuses the exact StoicTag fee path and keeps `APIARY` fund-less.
   - Confirm the **250.0** figure and that it's a governance-tunable const (add `A_UpdateDeployPrice`
     gated by Demiurgoi if so).

3. **The Cronoton keyset name + authority.** Confirm the HUB "Codex Cronoton" (the cron engine
   holding module-admin, not yet a full "Automaton") is the intended flipper, and pick the
   real keyset name (`ouronet-ns.apiary-cronoton-keyset` is a placeholder). Confirm whether
   Demiurgoi should also satisfy on/off as break-glass, or Cronoton-only. Confirm the
   Pythia→Cronoton trigger is authenticated on the HUB side (out of scope for this module, but
   the on-chain gate assumes it).

4. **Namespace + module name.** `APIARY` is my suggested name (an apiary of keys); the owner may
   prefer folding this into an existing module or naming it e.g. `PYTHIA` / `APIKEY`. Confirm the
   namespace (`ouronet-ns` per `CT_NS_USE`) and whether it's a standalone Stage-01 core module
   (like `CODEX` #22) with its own Talos client, or bolted onto `CODEX`.

5. **Pact version primitives.** Confirm the deployed Pact version supports the `with-default-read`
   binding form, `select`/`where`, `keys`, `map` over `keys`, `@event` on caps — all used by
   `CODEX`/`DALOS`, so almost certainly fine, but assert in a `.repl` before shipping.

6. **Read-shape for the list/count** (`keys+map` full rows vs `select` vs activated-only set) —
   confirm with the Pythia side which exact accessor the cache mirror will call so you expose the
   one it wants (`URC_ActivatedSet` is my bet for the hot cache; full-list for the directory).

7. **No per-account key limit — intentional.** Re-confirm with the owner that the ONLY gate is
   250 STOA and there is deliberately no cap on keys-per-account (spec §3a/§9). Don't add a
   per-owner counter or limit check "to be safe" — it contradicts the model.

---

## 12. Out of scope for this module (don't build here)

- **Apollo signature verification** — impossible in Pact; Pythia does it off-chain with Dalos.
  This module only stores the key + the switch.
- **The nonce challenge / redirect-sign handshake** — lives in Pythia + OuronetUI/Codex + the
  HUB, not on-chain.
- **The Pythia→Cronoton authenticated trigger** — HUB agent's job; on-chain you just gate the
  flip on the Cronoton keyset.
- **Per-request usage / rewards (stoicism)** — "Pythia meters, hub mints," aggregate only,
  never per-request on-chain writes. No counter field here.
- **Pythia's cache mirror, grant-check branch, denylist override, rate limiting, origin
  enforcement** — all Pythia-side (see `PYTHIA-CONSUMER-KEY-MODEL.md` §7).

---

## 13. References

- **Canonical spec:** `Pythia/docs/PYTHIA-CONSUMER-KEY-MODEL.md` (esp. §3 lifecycle, §5 hard
  rules, §6 on-chain registry sketch, §9 resolved/open).
- **Closest structural template (deployed):** `1_SOVEREIGN/STAGE_01/2_Core/22_CODEX.pact`
  (interface + registry table + `A_`/`C_`/`UR_`/`UDC_`/`XI_` split + owner cap + `DataOrNull`).
- **Fee-wiring template (deployed):** `1_SOVEREIGN/STAGE_01/3_Talos/06_TS01-C4.pact`
  (`CODEX|C_RegisterStoicTag` → `KDA|C_CollectWTEx` native-STOA collection one layer up).
- **Governance + prices + admin toggle idioms:** `1_SOVEREIGN/STAGE_01/2_Core/01_DALOS.pact`
  (`GOV|MD_DALOS`, `GOV|GAP` differ-check, `A_UpdateUsagePrice`, `URD_AccountCounter`,
  `CAP_EnforceAccountOwnership`).
- **Apollo glyph validators (reuse, don't reimplement):**
  `1_SOVEREIGN/STAGE_01/1_Utilities/08_U_DALOS.pact` (`GLYPH|UEV_ApolloAccount(Check)`,
  `UC_IzStoicTagName`).
- **Native-STOA split collector:** `1_SOVEREIGN/STAGE_01/2_Core/02_IGNIS.pact`
  (`KDA|C_CollectWTEx` + `C_TransferDalosFuel`).
- **DPTF single-treasury transfer precedent:**
  `1_SOVEREIGN/STAGE_02/2_Core/02_DEMIPAD/00_Demipad.pact` (`DPTF|C_Transfer … DEMIPAD|SC_NAME …`).
- **Nomenclature:** `OuronetInformational/MODULE_ARCHITECTURE.md`.
- **Prior handoff in the same house style (for tone/shape):**
  `OuronetInformational/01-mnemosyne-codex-pact-module.md`.

---

**One-line summary for the reviewer:** a tiny `CODEX`-shaped registry keyed on the `₱./Π.`
Apollo public string — **user-capped deploy that pays 250 STOA and inserts `activated=false`**,
**Cronoton-keyset-capped `TurnApiOn`/`TurnApiOff`** (the user can never self-activate → the
ping-pong), an optional owner-capped rename-for-a-price, and a set of **keyless `/local` `UR_`
reads** (is-activated, row, list-all, count, activated-set) that let Pythia stay keyless +
fund-less. Verify the STOA/treasury choice, the Cronoton keyset, and the deployed `U|DALOS`
Apollo validators before you write a line.