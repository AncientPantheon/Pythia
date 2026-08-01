# self-connector-codex-signing — Design

Follow-on correction to `self-connector-dual-link` (v2.6.0), triggered by direct user feedback after
using the deployed panel: Pythia should never generate or hold her own Apollo keypair locally —
generation belongs in Codex's own admin UI (proper seed-word/activation display), which is already
embedded in Pythia's admin page as the "Codex" tab.

**Note on scope and one retained decision, flagged for review:** this design was written after two
rounds of investigation into a live sibling repo (`constructors/Codex`) rather than guessed at — see
"Grounding" below. One consequence of the redesign (retiring `SelfConnectorLoop`'s pre-link
ownership-proof capability) retires previously-built, tested behavior. It's well-justified (see
Acceptance criterion 5's rationale) but is flagged explicitly here rather than decided silently,
since the user was asked a related question twice this round and didn't respond (away) — proceeding
on strong technical grounding per this session's established pattern, but this is the one point most
worth a second look.

## Grounding (investigated this session, not assumed)

1. **Codex's own admin tab (`codex-island.js`, already embedded in Pythia's admin page) already
   generates + deploys Standard+Smart Apollo identities with proper seed-word/confirmation UX**, via
   an `ActivateApolloPythiaKey` flow. This is what the user means by "generation is done within the
   codex" — her own Codex, not an external system.
2. **Generating via that tab already durably persists the identity server-side**, in Pythia's own
   sealed `codexBackup` (via `CodexStore.saveBackup`, already wired at the composition root as
   `codexStore`) — confirmed via `apps/pythia/src/automaton/codexStore.ts` and the installed
   `@ancientpantheon/codex@0.6.1`'s `CodexSnapshot.ouroAccounts: IOuroAccount[]` (present since Codex
   v0.3.0, not a newer-than-installed feature). `IOuroAccount.isSmart: boolean` + `address`/`publicKey`
   fields are exactly the Standard/Smart Apollo split.
3. **Codex `v0.7.0` (additive, no breaking changes vs. the installed `0.6.1`) ships
   `autoSignApolloChallenge`** (`@ancientpantheon/codex/ouronet`), built explicitly (per its
   changelog, dated 2026-07-30) for "a server-side Automaton (Pythia first)":
   ```ts
   autoSignApolloChallenge(
     snapshot: { ouroAccounts?: IOuroAccount[] },  // JSON.parse(codexStore.loadBackup())
     codexPassword: string,                         // codexStore.getOrCreateCodexPassword()
     apolloAccount: string,
     nonce: string,
     rp: string,
   ): Promise<{ apollo: string; sig: string }>
   ```
   Needs **zero human interaction after initial Codex setup** — both inputs come from
   `codexStore`, already held server-side under the existing `automaton/02` sealed-vault model
   (server-held auto-unlock, no operator prompt). Internally: finds the account in
   `snapshot.ouroAccounts`, decrypts its `.secret` via `smartDecrypt(secret, codexPassword)`, signs.
   This is the exact same shape Khronoton's `createPythiaKeyResolver`
   (`apps/pythia/src/automaton/khronoton/keyResolver.ts`) already uses for Kadena signing — an
   established, idiomatic pattern in this codebase, not a new one.

## Problem

Today (v2.6.0), `SelfApolloVault` generates a fresh Apollo keypair per half locally
(`Apollo.generateRandom()`) via a "Generate" button, sealing the raw private key material into
Pythia's own bespoke `SealedStore` — with zero visibility into what was generated (no seed display,
no confirmation) and no relationship to Codex's own, already-built, proper generation UI. The
resulting `self-apollo-standard`/`self-apollo-smart` entries then sit in the Security panel's sealed-
credentials list indistinguishable from genuinely sensitive secrets (`codexPassword`,
`hubHmacSecret`) — which is what visibly tipped the user off that something was architecturally
wrong. Generation should happen exactly once, in exactly one place (Codex's own tab), with proper
custody from the start.

## Approach

**Bump `@ancientpantheon/codex` from `^0.6.1` to `^0.7.0`** in `apps/pythia/package.json` (additive,
already confirmed no breaking changes).

**New `apps/pythia/src/automaton/codexApolloSigner.ts`** — `createCodexApolloSigner(codex:
CodexStore, apolloAccount: string): ApolloSigner`, mirroring `keyResolver.ts`'s exact pattern
(re-reads `codex.loadBackup()` + `codex.getOrCreateCodexPassword()` fresh on every call — fire-time,
not hot-path, so a Codex edit is picked up next call and plaintext key material never outlives the
call) — delegates to `autoSignApolloChallenge`. A clear, named error (not a silent failure) when
`codexBackup` isn't initialized yet, or the account isn't found in `ouroAccounts`.

**`SelfApolloVault` (kept, name unchanged — minimizes import/rename churn across admin routes/tests;
its doc comments get rewritten since its actual role changes substantially) drops ALL local
generation:**
- `ensureGenerated()` — removed entirely. No more `Apollo.generateRandom()` anywhere in this class.
- `standardAccount()`/`smartAccount()` — become **derived** from the currently-set `dualLinkKey()`
  (via `splitDualLinkKey`, already published), not independently persisted. Answers the user's own
  question directly: we don't need to separately store the halves — they're always recoverable from
  the one thing that IS worth persisting, the linked dual-link-key itself.
- `setDualLinkKey(key)` — validation changes from "matches this vault's own generated accounts" (no
  longer meaningful — nothing is generated here anymore) to **"both halves are present in Codex's own
  current `ouroAccounts` snapshot"** (via the same `codexStore` this class now holds) — a strictly
  MORE meaningful check than before: it confirms Pythia can actually sign for both halves, not just
  that a string matches another string.
- `createSigner(which)` — returns `createCodexApolloSigner(this.codex, account)` instead of reading
  local sealed key material. Constructor becomes `constructor(store: SealedStore, codex:
  CodexStore)` — `store` still persists only the pasted `dualLinkKey` (public data, still sealed for
  restart-durability, matching v2.6.0's existing choice); `codex` is the new Codex-backed signing
  source.

**`SelfConnectorLoop`'s self-deriving-key logic (added mid-build in `self-connector-dual-link`) is
reverted** — but for a different, still-valid reason. Last topic, `tick()` was changed to derive its
own key from `vault.standardAccount()`/`smartAccount()` rather than waiting on
`vault.dualLinkKey()`, specifically because those accounts WERE locally known the moment generation
happened. Now, with generation gone, there IS no account knowledge independent of an explicitly
pasted `dualLinkKey` — so `tick()` reverts to gating construction on `vault.dualLinkKey()` being set
(this is now the ONLY correct gate, not a regression of the earlier fix).

**`SelfConnectorHalfStatus`/`SelfConnectorHalfView` drop the `"not-generated"` state** — with no local
generation step, there's nothing to distinguish "not generated" from "not linked" anymore; the
lifecycle simplifies to `"not-linked" | "pending" | "active"`.

**Admin UI**: the "Generate" button, its route (`POST /admin/self-connector/generate`), and
`SelfConnectorAdminControls.generate()` are removed entirely. The Self Connector panel becomes
exactly what the user asked for: one field (paste the dual-link-key), a Link button, and status
display (masked secret + countdown, unchanged from v2.6.0) — nothing else. Panel copy updated to
point the operator at the Codex tab for generation + on-chain deployment.

**Final task**: update `organs/06-pythia-client-wire-in.md` again — correct the description of
Pythia's own self-connector reference implementation to the Codex-backed model, and be explicit that
this is Pythia's OWN chosen solution (she happens to run a Codex in-process) — a consumer without an
in-process Codex (e.g. Mnemosyne, unless it adopts Codex itself) still needs SOME durable, server-
side-accessible signing source of its own; this doc shouldn't imply Codex is a universal requirement,
just Pythia's actual answer to "who signs, unattended."

## Alternatives considered

- **Export the Codex-generated private key and re-import it into Pythia's own `SealedStore`** —
  rejected: defeats Codex's own deliberate "private key never leaves [Codex's custody]" security
  model for no benefit, when Codex's snapshot is ALREADY durably held server-side in the same
  process and already has a purpose-built autonomous-signing primitive (`autoSignApolloChallenge`).
- **Build a new generic Apollo-signing primitive into Codex's backend from scratch** — moot: it
  already exists (`autoSignApolloChallenge`, v0.7.0), just needed discovering and a dependency bump.
- **Give up on unattended refresh, require periodic human re-verification instead** — rejected: no
  longer necessary once `autoSignApolloChallenge` is confirmed to need zero human interaction after
  initial setup.

## Acceptance criteria

- [ ] The Self Connector admin panel has no "Generate" button, route, or control anywhere — only a
      dual-link-key paste field and status display.
- [ ] `SelfApolloVault` contains no call to `Apollo.generateRandom()` anywhere, and its
      `self-apollo-standard`/`self-apollo-smart` `SealedStore` entries are never written again (a
      fresh vault has neither).
- [ ] Pasting a dual-link-key whose halves are NOT both present in Codex's current `ouroAccounts`
      snapshot is rejected immediately with a clear error — no tick, no signer call.
- [ ] Pasting a dual-link-key whose halves ARE both present in Codex's snapshot, and which is
      genuinely active on-chain, drives `SelfConnectorLoop` to `"active"` using
      `autoSignApolloChallenge`-backed signing — with zero password prompt or human interaction
      after the initial paste.
- [ ] `apps/pythia/src/selfConnectorIntegration.test.ts`'s pre-link ownership-proof scenario for
      Pythia's OWN self-connector is removed (it tested a capability `SelfConnectorLoop` can no
      longer perform, since there's no account knowledge independent of a paste) — with a doc
      comment explaining why, and confirmation that `connector-activation-resolver`'s own test suite
      (`pendingActivationTracker.test.ts`, `dualLinkActivateResolver.test.ts`,
      `connectorAuth.test.ts`'s activation-tracker-hook tests) still fully covers the GENERIC
      mechanism external consumers use — nothing about that shared capability is removed, only
      Pythia's own participation in exercising it pre-link.
- [ ] `organs/06-pythia-client-wire-in.md` describes the Codex-backed reference implementation
      accurately, without implying every future consumer must also run an in-process Codex.
- [ ] `SelfConnectorLoop`'s own tick/refresh interval (distinct from the ephemeral-secret TTL already
      differentiated in v2.6.0) is 24h for Pythia's self-connector — matching her 24h secret lifetime,
      so she doesn't re-check 8x more often than necessary. `DualLinkConnector`'s own default interval
      (used by any other consumer via the published SDK) stays at its existing 3h default, unchanged.

## Addendum — tick-interval differentiation (added after user approval)

User's own words, approving this design: *"you also need to set up the interval to 24 hours for
pythia and 3 hours for the other consumers."* This is the TICK/REFRESH interval
(`SelfConnectorLoopOptions.intervalMs`/`DualLinkConnectorOptions.intervalMs` — how often the
connector re-checks/refreshes), distinct from the ephemeral-secret TTL already differentiated in
v2.6.0 (24h self / 6h default — that part is unchanged, already shipped, not touched by this topic).
Today both loop implementations default their tick interval to a flat 3h
(`DEFAULT_INTERVAL_MS`). Fix: `SelfConnectorLoop`'s own `DEFAULT_INTERVAL_MS` (used ONLY by Pythia's
self-connector — a private, unpublished class with exactly one construction site, `index.ts`)
changes from 3h to 24h. `DualLinkConnector`'s own `DEFAULT_INTERVAL_MS` (the published SDK class any
other consumer constructs) stays at 3h, unchanged — this already matches "3 hours for the other
consumers," so no code change is needed there, just confirmation it stays as-is.

## Out of scope

- Any change to Codex's own generation UI (`codex-island.js`) or its `ActivateApolloPythiaKey`
  on-chain deploy flow — already correct, already what the user wants used.
- Any change to the browser-based `/apollo-verify` ownership-verifier flow (`signApolloOwnership`,
  `connectorVerify.ts`) — that flow's "never leaves the browser" property is a deliberate, correct
  security boundary for its own (different) purpose, unrelated to this topic.
- Building Apollo-signing support for consumers that don't run Codex in-process — out of scope for
  Pythia's own implementation; a future Mnemosyne-side concern.
- The `pythia-cronoton-keyset` re-pointing / Cronoton auto-activation for arbitrary future consumers —
  unrelated, standing external blocker, unaffected by this topic.
