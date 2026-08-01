## Wave 1

- [x] T1: `apps/pythia/src/automaton/codexApolloSigner.ts` — Codex-backed Apollo signing — done when:
      `apps/pythia/package.json`'s `"@ancientpantheon/codex"` dependency bumps from `"^0.6.1"` to
      `"^0.7.0"` (`npm install` from the repo root regenerates `package-lock.json` to match — this
      task owns that lockfile change too). New file exports:
      ```ts
      export function codexHoldsAccount(codex: CodexStore, apolloAccount: string): boolean;
      export function createCodexApolloSigner(codex: CodexStore, apolloAccount: string): ApolloSigner;
      ```
      (`ApolloSigner` imported from `@ancientpantheon/pythia-client`, already a dependency; `CodexStore`
      imported from `./codexStore.js`). Mirrors `apps/pythia/src/automaton/khronoton/keyResolver.ts`'s
      exact pattern (read that file first in full): a private `loadSnapshot(codex: CodexStore):
      {ouroAccounts?: IOuroAccount[]}` helper that calls `codex.loadBackup()`, throws a clear named
      `Error` if `null` (mirror `keyResolver.ts`'s `loadSnapshot`'s own error message style, adapted:
      `` `codex apollo signer: Pythia's operator codex is not initialized — generate and activate her Apollo identity under /admin (Codex) first.` ``), else `JSON.parse`s it. Both exported functions
      call `loadSnapshot` FRESH on every invocation (never cached) — mirrors `keyResolver.ts`'s own
      "re-read every call, fire-time not hot-path" discipline exactly.
      `codexHoldsAccount(codex, apolloAccount)`: returns `true` iff `snapshot.ouroAccounts` (defensively
      defaulting to `[]` if not an array, mirroring `keyResolver.ts`'s `ouros()` helper) contains an
      entry whose `.address === apolloAccount` — match on `address`, NOT `publicKey` (confirmed this
      session: `IOuroAccount.address` is the actual `₱.…`/`Π.…` account string;
      `autoSignApolloChallenge`'s own test in the Codex repo passes `account.address` as the
      `apolloAccount` argument, and `.publicKey` is documented as "Codex-local public key," a
      different value). Returns `false` (not a throw) when `codex.loadBackup()` is `null` — this is a
      query, not an action; "not initialized yet" is just "doesn't hold it yet."
      `createCodexApolloSigner(codex, apolloAccount)` returns an `ApolloSigner` whose `sign({
      apolloAccount: signedAccount, nonce, rp })` (per `ApolloSigner`'s existing interface — the
      account param is confusingly named the same as the closure's own `apolloAccount`, so name the
      inner param `signedAccount` to avoid shadowing) FIRST asserts `signedAccount === apolloAccount`
      (throws `` `codex apollo signer: asked to sign for ${signedAccount} but this signer is scoped to ${apolloAccount}` `` on mismatch — defense-in-depth, mirrors the cross-check the OLD
      `selfApollo.ts`'s `createSigner` used to have), THEN calls `loadSnapshot(codex)` +
      `codex.getOrCreateCodexPassword()`, then `import("@ancientpantheon/codex/ouronet")`'s
      `autoSignApolloChallenge(snapshot, codexPassword, apolloAccount, nonce, rp)` (dynamic import —
      mirrors this codebase's existing dynamic-import convention for the DALOS/Apollo primitives, e.g.
      `apolloVerify.ts`/the old `selfApollo.ts`'s own pattern — ESM-only, a load failure must surface
      as a thrown error, not silently sign garbage), and maps the returned `{apollo, sig}` to `{
      signature: sig }` (the `ApolloSigner.sign` return shape).
      Tests (TDD, write first) in `apps/pythia/src/automaton/codexApolloSigner.test.ts`:
      - Construct a `CodexStore` over a real `SealedStore` (mirror the `mkdtempSync`/`parseMasterKey`
        pattern already used in `selfApollo.test.ts`/`khronoton/keyResolver.test.ts` if one exists,
        else mirror `selfApollo.test.ts`'s own `store()` helper). Before any `saveBackup` call:
        `codexHoldsAccount(codex, "₱.whatever")` returns `false` (no throw); `createCodexApolloSigner(
        codex, "₱.whatever").sign(...)` REJECTS with a message containing "not initialized".
      - Seed a real snapshot: build one `IOuroAccount`-shaped object with a genuine Apollo keypair
        (generate via `(await import("@ouronet/dalos-crypto/registry")).Apollo.generateRandom()`,
        matching this codebase's existing convention — do NOT hand-roll fixture key material),
        `address` set to the generated standard (or smart) address, `secret` set to the ENCRYPTED
        private key (encrypt via whatever this codebase's existing encryption helper is — check
        `smartDecrypt`'s sibling `smartEncrypt`/`encryptStringV2` import path used in
        `apollo-verify-auto-sign.test.ts` in the Codex repo's own test, mirror it exactly so the
        round-trip is realistic), `codexPassword.set(codex.getOrCreateCodexPassword())`, save via
        `codex.saveBackup(JSON.stringify({ouroAccounts: [that account]}))`. Then:
        `codexHoldsAccount(codex, thatAddress)` returns `true`; `codexHoldsAccount(codex,
        "₱.some-other-account")` returns `false`.
      - `createCodexApolloSigner(codex, thatAddress).sign({apolloAccount: thatAddress, nonce: "n1",
        rp: "pythia.ancientholdings.eu"})` resolves to `{signature: expect.any(String)}`, and that
        signature independently verifies via `Apollo.verify(signature, buildChallengeMessage({
        apollo: thatAddress, nonce: "n1", rp: "pythia.ancientholdings.eu"}), <the generated public
        key>)` — proves the round trip is REAL, not just "didn't throw."
      - `createCodexApolloSigner(codex, thatAddress).sign({apolloAccount: "₱.different", nonce: "n",
        rp: "r"})` rejects with a message containing "asked to sign for" (the scope-mismatch guard).
      - `createCodexApolloSigner(codex, "₱.not-in-snapshot").sign({apolloAccount:
        "₱.not-in-snapshot", nonce: "n", rp: "r"})` rejects (propagates whatever
        `autoSignApolloChallenge` throws for an unknown account — assert SOME rejection, don't
        over-specify the exact message since that's Codex's own, not this file's, contract).
      `npm run typecheck -w @ancientpantheon/pythia` and the new test file both clean.
  - files: `apps/pythia/package.json`, `package-lock.json`, `apps/pythia/src/automaton/codexApolloSigner.ts`, `apps/pythia/src/automaton/codexApolloSigner.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T2: `SelfApolloVault` drops local generation; `SelfConnectorLoop` reverts to gating on the
      pasted key and gets the 24h self-interval — done when:
      `apps/pythia/src/automaton/selfApollo.ts`: constructor becomes `constructor(private readonly
      store: SealedStore, private readonly codex: CodexStore)` (import `CodexStore` from
      `./codexStore.js`). REMOVE entirely: `ensureGenerated()`, `doEnsureGenerated()`, the
      `generating` in-flight-dedup field, `ENTRY_NAMES`, `SealedHalf` interface, `parseHalf()`,
      `SelfApolloAccounts` interface, the dynamic `@ouronet/dalos-crypto/registry` import (no longer
      needed in this file at all — signing is now T1's job). `standardAccount()`/`smartAccount()`
      become: `standardAccount(): string | null { const key = this.dualLinkKey(); return key ?
      splitDualLinkKey(key).standardApollo : null; }` (mirror for `smartAccount`/`.smartApollo`).
      `dualLinkKey()` unchanged. `setDualLinkKey(key: string): void`: still calls `splitDualLinkKey(
      key)` first (malformed key still throws `PythiaConnectorValidationError` unchanged — this
      validation is orthogonal to the redesign). Then, for EACH half, calls `codexHoldsAccount(
      this.codex, half)` (from `./codexApolloSigner.js`, T1) — if either returns `false`, throws ``
      `self-apollo: the ${which} half (${account}) of this dual-link-key is not held by Pythia's own
      Codex — generate and activate it there first` `` (naming the specific missing half; check
      standard first, then smart, matching the existing two-branch error-message convention). Only
      when BOTH are held does `this.store.set(DUAL_LINK_KEY_ENTRY, key)` run.
      `createSigner(which: "standard" | "smart"): ApolloSigner`: `const account = which ===
      "standard" ? this.standardAccount() : this.smartAccount(); return { sign: async (input) => {
      if (!account) throw new Error(\`self-apollo: no dual-link-key set — the "${which}" half is
      unknown\`); return createCodexApolloSigner(this.codex, account).sign(input); } };` (the
      not-yet-linked check must happen INSIDE the returned signer's `sign`, not at `createSigner`
      call time, since `SelfConnectorLoop` constructs signers once and may call `.sign` before or
      after a key is later set — mirror the OLD file's own "throws inside sign(), not at construction"
      shape, just against the new not-yet-linked condition instead of not-yet-generated).
      `apps/pythia/src/automaton/selfConnectorLoop.ts`: `DEFAULT_INTERVAL_MS` changes from `3 * 60 *
      60 * 1000` to `24 * 60 * 60 * 1000`, with its doc comment updated to explain this class has
      exactly one construction site (Pythia's own self-connector, `index.ts`) so its own default IS
      Pythia's interval — matching her 24h ephemeral-secret TTL (v2.6.0), not the 6h/3h defaults
      other consumers' own `DualLinkConnector` instances use. (No task in this plan touches
      `packages/pythia-client` at all — `DualLinkConnector`'s OWN `DEFAULT_INTERVAL_MS` stays 3h by
      simple omission, satisfying the design's "3 hours for other consumers, unchanged" criterion
      without any code change there; confirm this by grepping `packages/pythia-client/src/
      dualLinkConnector.ts` for `DEFAULT_INTERVAL_MS` at the end of this task and observing it is
      still `3 * 60 * 60 * 1000`, untouched.) `tick()`'s lazy-build gate changes from
      checking `vault.standardAccount()`/`vault.smartAccount()` independently to checking
      `vault.dualLinkKey()` directly: `if (!this.dualLinkConnector) { const dualLinkKey =
      this.vault.dualLinkKey(); if (!dualLinkKey) return; this.dualLinkConnector = new
      DualLinkConnector({ dualLinkKey, baseUrl: this.baseUrl, standardSigner:
      this.vault.createSigner("standard"), smartSigner: this.vault.createSigner("smart"), fetchImpl:
      this.fetchImpl, intervalMs: this.intervalMs }); }` wrapped in the SAME try/catch already added
      during the last topic's review (unchanged, still valid — a malformed `dualLinkKey` string
      should not be reachable in practice since `setDualLinkKey` already validated it, but the guard
      stays as defense-in-depth). `SelfConnectorHalfStatus` drops the `"not-generated"` variant —
      becomes `{status: "not-linked"} | {status: "pending"} | {status: "active"; secret: string;
      expiresAt: number}`. `halfStatus()` simplifies to `private halfStatus(which: Half):
      SelfConnectorHalfStatus { if (!this.dualLinkConnector) return {status: "not-linked"}; return
      this.mapHalfStatus(which === "standard" ? this.dualLinkConnector.status().standard :
      this.dualLinkConnector.status().smart); }` (drops the `account: string | null` parameter
      entirely — no longer needed since there's no independent "not-generated" case to distinguish).
      Tests (TDD, write first):
      - `apps/pythia/src/automaton/selfApollo.test.ts`: REWRITE in full (the old file's tests are
        almost entirely obsolete — `ensureGenerated`/local-keypair tests no longer apply). New
        structure: a `codex()` helper builds a fresh `CodexStore` per test (mirror the existing
        `store()`/`mkdtempSync` pattern for the OUTER `SealedStore`, construct `CodexStore` over it).
        A `seedCodexWithRealPair()` helper generates a REAL Apollo standard+smart pair (via
        `Apollo.generateRandom()`, matching T1's own test convention) and seeds the codex's
        `ouroAccounts` snapshot with both — reuse/import T1's own test fixture-building approach if
        it's factored reusably, else duplicate the small amount of setup (a few lines) rather than
        creating a cross-test-file coupling. Tests: `standardAccount()`/`smartAccount()` are `null`
        before any `setDualLinkKey` call; after `setDualLinkKey` with a well-formed key whose BOTH
        halves are in the seeded codex snapshot, `dualLinkKey()`/`standardAccount()`/`smartAccount()`
        all return the expected derived values; `setDualLinkKey` with a malformed key still throws
        `PythiaConnectorValidationError` (unchanged behavior, one regression test); `setDualLinkKey`
        with a well-formed key whose standard half is NOT in the codex snapshot throws mentioning
        "not held by Pythia's own Codex" AND "standard" specifically, `dualLinkKey()` stays `null`;
        mirrored test for the smart half; `createSigner("standard").sign(...)` before any
        `setDualLinkKey` call rejects with a message containing "no dual-link-key set"; after
        `setDualLinkKey` with a real, codex-held pair, `createSigner("standard").sign({
        apolloAccount: <the standard account>, nonce: "n", rp: "pythia.ancientholdings.eu"})`
        resolves to a signature that independently verifies via `Apollo.verify` against the seeded
        keypair's public key (a REAL round trip, not a mock — same rigor as T1's own signer test).
      - `apps/pythia/src/automaton/selfConnectorLoop.test.ts`: REWRITE the setup in every existing
        test — every `vault.ensureGenerated()` call becomes `seedCodexWithRealPair()` (seed Codex's
        snapshot directly, no vault generation exists anymore) + `vault.setDualLinkKey(key)`
        (constructing `key` from the seeded pair's own two addresses joined via `DUAL_LINK_BAR`, same
        as today). The "status() before generation"/"not-generated" describe blocks and tests are
        REMOVED (that state no longer exists) — replaced by: "status() reports not-linked for both
        halves before any dual-link-key is set" (no codex seeding needed for this one — just an
        empty vault) and "tick() with no dual-link-key set ever resolves without throwing, verifyCalls
        stays empty, status stays not-linked for both halves" (this is the MIRROR-IMAGE of last
        topic's now-obsolete "self-derives without a paste" regression test — this topic's whole
        point is reverting that self-derivation, so this new test proves the REVERTED behavior: no
        paste, no tick activity at all). Every remaining tick()/start()-stop() test keeps its existing
        assertions (they test `DualLinkConnector`-delegation behavior that's unchanged by this topic)
        but with the seed-then-link setup swapped in as described. The "a half missing entirely"
        test pair (both directions, added last topic) become: seed only ONE half into Codex's
        snapshot (not "delete one of two generated halves" — there's no local generation to delete
        from anymore) and confirm `setDualLinkKey` itself REJECTS (per T2's new validation) rather
        than silently producing a not-linked non-throwing state — this is a MEANINGFULLY DIFFERENT,
        better test than before (the old version tested a "one generated, one missing" case that
        can't happen anymore; the new version tests "one held by Codex, one not" at the actual new
        validation boundary, `setDualLinkKey` itself).
      Run `npx vitest run apps/pythia/src/automaton/selfApollo.test.ts
      apps/pythia/src/automaton/selfConnectorLoop.test.ts` and `npm run typecheck -w
      @ancientpantheon/pythia` — both clean.
  - files: `apps/pythia/src/automaton/selfApollo.ts`, `apps/pythia/src/automaton/selfApollo.test.ts`, `apps/pythia/src/automaton/selfConnectorLoop.ts`, `apps/pythia/src/automaton/selfConnectorLoop.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T3: `apps/pythia/src/admin/routes.ts` — drop `generate()` + its route; simplify the state
      union — done when:
      `SelfConnectorAdminControls` loses `generate(): Promise<SelfConnectorStatus>` — only `status()`
      and `link(dualLinkKey: string): Promise<SelfConnectorStatus>` remain. `registerAdmin`'s `if
      (selfConnector) {...}` block loses the `app.post("/admin/self-connector/generate", ...)` route
      entirely — only the `GET /admin/self-connector` and `POST /admin/self-connector/link` routes
      remain, unchanged in shape. `SelfConnectorHalfView.state`'s type union drops `"not-generated"`:
      becomes `"not-linked" | "pending" | "active"`. Update both interfaces' doc comments (rewritten
      last topic to describe the self-deriving-key semantics that this topic reverts) to describe the
      simpler, current reality: no local generation, no independent "generated" concept — either a
      dual-link-key is linked (and Codex either can or can't sign for both its halves) or it isn't.
      Tests (TDD, write first) in `apps/pythia/src/admin/routes.test.ts`:
      - Remove the `generate: vi.fn(...)` field from the FAKE `selfConnector` object in the existing
        `"admin /admin/self-connector[/generate] — SelfConnectorAdminControls extra"` describe block
        (rename the describe block's title to drop "[/generate]" too — it no longer exists), and
        remove the `"POST /admin/self-connector/generate calls the fake's generate()..."` test
        entirely. Update the `FIXTURE` object's `standard`/`smart` fields to use only the 3-state
        union (no `"not-generated"` fixture value anywhere in this block).
      - The `"REAL SelfApolloVault + SelfConnectorLoop wiring"` describe block's `makeRealApp` helper
        needs a REAL `CodexStore` now (construct one over the same `SealedStore`/`dir` the block
        already uses, or a second `SealedStore` instance — either is fine as long as it's real, not a
        fake), passed as `SelfApolloVault`'s second constructor argument. Its `selfConnector` extras
        object drops the `generate` closure entirely (mirroring T2's removed method) — only `status`
        and `link` remain, `link` unchanged (`async (dualLinkKey) => { vault.setDualLinkKey(
        dualLinkKey); return status(); }`). The existing test that called `POST
        /admin/self-connector/generate` before asserting a populated status needs its whole premise
        replaced: since there's no generate step anymore, seed the REAL codex's `ouroAccounts`
        snapshot directly (mirror T2's own test-seeding helper, `seedCodexWithRealPair`-shaped) with
        a real Apollo pair BEFORE constructing the app, then assert `GET /admin/self-connector`
        reports `standardAccount: null, smartAccount: null, dualLinkKey: null, standard: {state:
        "not-linked", ...}, smart: {state: "not-linked", ...}` (nothing is "known" until a key is
        POSTed — codex holding key material doesn't by itself populate Pythia's status). Then `POST
        /admin/self-connector/link` with the seeded pair's own dual-link-key succeeds (200), and the
        subsequent `GET` echoes `dualLinkKey` + still reports `"not-linked"` for both halves (no tick
        has run in this describe block, matching the existing convention — unchanged from last
        topic's reasoning). The existing mismatch-rejection test (added last topic, posts a key with
        one genuinely different half) needs updating: the "different half" must now come from an
        account that is NOT in the seeded codex's `ouroAccounts` (rather than "a different vault's
        generated account," which no longer means anything) — assert the 400 response's `error`
        field contains "not held by Pythia's own Codex" and names the correct mismatched half.
      Run `npx vitest run apps/pythia/src/admin/routes.test.ts` and `npm run typecheck -w
      @ancientpantheon/pythia` — both clean.
  - files: `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/routes.test.ts`

- [x] T4: `apps/pythia/src/selfConnectorIntegration.test.ts` — retire the pre-link scenario, keep and
      update the isSelfAccount/TTL scenario — done when:
      The FIRST test in the file (`"tick() drives both of Pythia's own self-proofs through the REAL
      connector-auth + pending-activation pairing with zero self-case branching, and the dual-link-
      activate resolver picks up the resulting pair"`) is REMOVED in full, along with any
      now-unused imports/helpers it alone required (`PendingActivationTracker`,
      `createDualLinkActivateResolver`, `readApolloCounterpart`-shaped stubs — check whether the
      SECOND test also needs any of these before removing an import; it should not). Replace it with
      a short doc comment at the top of the file explaining the retirement: this scenario tested
      `SelfConnectorLoop` proving ownership of a NOT-YET-linked pair (no `dualLinkKey` set) to feed
      `PendingActivationTracker` toward Cronoton auto-activation — a capability `SelfConnectorLoop`
      can no longer perform now that there's no account discovery independent of an explicitly
      pasted `dualLinkKey` (`docs/work/self-connector-codex-signing/design.md`). This is a deliberate
      retirement, not a regression: the user's actual workflow for Pythia's OWN identity is firing
      `A_Link` manually, never relying on the auto-activation pipeline for herself. The GENERIC
      mechanism (`PendingActivationTracker`, `createDualLinkActivateResolver`,
      `connectorAuth.ts`'s activation-tracker hook) remains fully intact and tested for real external
      consumers — point at `apps/pythia/src/connectors/auth/pendingActivationTracker.test.ts`,
      `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.test.ts`, and
      `connectorAuth.test.ts`'s own `"connector auth (activation-tracker hook)"` describe block as
      where that coverage lives.
      The SECOND test (`"wires isSelfAccount exactly as index.ts does..."`, added during last
      topic's review) is KEPT but its setup is rewritten: currently calls `vault.ensureGenerated()`
      then constructs a `SelfConnectorLoop` and ticks directly with no `dualLinkKey` ever set (relying
      on the now-reverted self-derivation). Rewrite to: construct a `CodexStore` (new `SealedStore` +
      `CodexStore` pair, or reuse the existing `sealedStore`/`vault` already in this test — read the
      file's current top-of-test setup first), seed its `ouroAccounts` snapshot with a real generated
      Standard+Smart pair (mirror T1/T2's own seeding helper shape — a few lines, fine to duplicate
      rather than cross-import from a test file), construct `SelfApolloVault` with BOTH the
      `SealedStore` and the `CodexStore`, call `vault.setDualLinkKey(...)` with the seeded pair's own
      dual-link-key, THEN proceed with the rest of the test unchanged (drive `tick()` through the
      REAL `registerConnectorAuth` with `isSelfAccount` wired exactly as `index.ts` does, assert the
      24h vs. 6h TTL differentiation — this part of the test's logic is unaffected by this topic,
      only its SETUP changes). Also update the `publicKeyFor`/signing-related helper functions in
      this test (the ones that read `self-apollo-standard`/`self-apollo-smart` sealed entries
      directly and sign with `registry.Apollo.sign` locally) since those sealed entries no longer
      exist — the account's public key for `readApolloPublicKey` stubbing should come from the
      seeded Codex snapshot's `IOuroAccount.publicKey`/derived-from-`address` instead, and any
      OTHER-account signing (the non-self TTL comparison half of this test) can keep signing with a
      throwaway locally-generated keypair exactly as it does today (that part was never about
      Pythia's own self-identity, no change needed there).
      Run `npx vitest run apps/pythia/src/selfConnectorIntegration.test.ts` and `npm run typecheck -w
      @ancientpantheon/pythia` — both clean.
  - files: `apps/pythia/src/selfConnectorIntegration.test.ts`

## Wave 4 (depends on Wave 3)

- [x] T5: `apps/pythia/src/index.ts` — composition-root wiring — done when:
      `selfApolloVault` construction becomes `new SelfApolloVault(sealedVault, codexStore)` (the
      existing `codexStore` export, already constructed at line ~146 — reuse it, don't reconstruct;
      confirm it's declared BEFORE `selfApolloVault`'s construction site, reordering the two `const`/
      `export const` statements if the current file has them the other way around). The
      `selfConnector` extras object passed to `registerAdmin(...)` drops its `generate: async () =>
      {...}` closure entirely — only `status` and `link` remain (mirroring T3's interface change).
      `selfConnectorStatus()`'s `toHalfView`-equivalent mapping (added last topic) simplifies to the
      new 3-state union — drop whatever branch handled `"not-generated"`. `isSelfAccount`'s closure
      (`account === selfApolloVault.standardAccount() || account === selfApolloVault.smartAccount()`)
      is UNCHANGED — still correct, since those getters still exist with the same names and signature,
      just implemented differently underneath.
      No dedicated test file (unchanged caveat from every prior topic touching this file) —
      correctness rests on matching T3's already-tested "REAL wiring" reference shape in
      `routes.test.ts` exactly.
      Verification: `npm run typecheck -w @ancientpantheon/pythia` clean; `npm test -w
      @ancientpantheon/pythia` full suite green, paying particular attention to
      `selfConnectorIntegration.test.ts` and `admin/routes.test.ts` in the output.
  - files: `apps/pythia/src/index.ts`

- [x] T6: `apps/pythia/public/admin.html` + `apps/pythia/public/admin.js` — remove the Generate
      control, simplify the state mapping — done when:
      `admin.html`'s Self Connector section loses the `<div class="conn-actions"><button
      type="button" id="selfconn-generate-btn" ...>Generate</button></div>` block and its sibling `<p
      class="conn-error" id="selfconn-generate-error" hidden></p>` entirely — only the Link
      input/button block (already the whole point of last topic) and the two `.sec-status` divs
      remain. The panel-note `<p>` at the top of the section is rewritten: currently says "generated
      locally and (as a separate, manual, out-of-band step) deployed and linked on chain via Codex" —
      update to describe the ACTUAL flow now: generate + activate the pair using the Codex tab
      FIRST (link to it conceptually in the copy, e.g. "Generate and activate this pair using the
      Codex tab" — no need for an actual `<a>` hyperlink/anchor unless one already exists elsewhere
      in this file for cross-tab references; check and mirror if so, else plain text is fine), THEN
      come back here and paste the resulting dual-link-key once it's active on-chain.
      `admin.js`: `selfConnectorHalfView(half)` drops its `"not-generated"` → badge case (the
      function's remaining cases: `"active"`, `"pending"`, `"not-linked"`, unchanged). `
      renderSelfConnector(st)` loses the `generateBtn`-related lines (the `document.getElementById(
      "selfconn-generate-btn")` lookup and its `.hidden = ...` toggle logic). `wireSelfConnector()`
      loses its ENTIRE Generate-button `if (generateBtn) {...}` block (the click listener, disable/
      fetch/error/finally shape) — only the Link-button wiring (already built last topic) and the 1s
      countdown interval + 60s poll interval (both already built last topic, untouched) remain.
      Verification (no automated test harness exists for these files, matching every prior topic's
      convention for this file pair): `node --check apps/pythia/public/admin.js` clean; re-grep both
      files to confirm `selfconn-generate-btn`/`selfconn-generate-error` no longer appear ANYWHERE in
      either file (not just removed from one side — a leftover reference in the other file would be
      exactly this file pair's most common real bug class per every prior topic's own review); every
      remaining `admin.js`-referenced `id` still has a matching `id` in `admin.html`.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

## Wave 5 (depends on Wave 4)

- [x] T7: Update the Pantheon architecture handoff doc — done when:
      `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` (repo root
      `/home/ancientbox/ClaudeWS/AncientPantheon/websites/Pantheon`)'s §2e (added last topic,
      "Consuming an already-active dual-link-key — the now-proven pattern") gets corrected: its
      citation of Pythia's own Self Connector admin panel as "the concrete, working reference
      implementation" is still accurate for the PASTE-IN mechanism itself, but any text implying
      Pythia GENERATES her own identity locally (if any survived from last topic's wording — read the
      current file in full first, don't assume) must be corrected to describe the REAL current flow:
      generation + on-chain activation happens via Pythia's own Codex admin tab (proper seed-word/
      confirmation UX, NOT a bespoke local vault), and ongoing unattended signing is delegated to
      Codex's `autoSignApolloChallenge` (`@ancientpantheon/codex/ouronet`, v0.7.0+) — server-side,
      zero human interaction after initial Codex setup. Add an explicit note: this is Pythia's OWN
      chosen solution because she happens to run a Codex in-process; a consumer WITHOUT an in-process
      Codex (e.g. Mnemosyne, unless it adopts Codex itself) still needs SOME durable, server-side-
      accessible signing source of its own — this doc's `DualLinkConnector`/`ApolloSigner` contract
      doesn't require Codex specifically, only SOME real implementation of the `ApolloSigner`
      interface, wherever a consumer's own key material actually lives. `docs/pantheonic-
      architecture/CHANGELOG.md` (same repo) gains a matching entry, following its existing format
      (check a few recent entries for the exact convention).
      No automated test for documentation files. Verification: re-read the final diff and confirm it
      (a) doesn't contradict §2c/§2d/the rest of §2e, (b) is technically accurate against the actual
      shipped code from T1-T6 (quote real function/type names, not invented ones), (c) is
      self-contained for a zero-context Mnemosyne-side agent. This task's own completion report
      states the exact filename (`organs/06-pythia-client-wire-in.md`) again, per the standing
      instruction to relay it to the user each time it's touched.
  - files: `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md`, `websites/Pantheon/docs/pantheonic-architecture/CHANGELOG.md`
