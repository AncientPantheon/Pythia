# pythia-self-consumer — Plan

Design: `docs/work/pythia-self-consumer/design.md`. Test command: `npm test -w @ancientpantheon/pythia`.
Repo root: `/home/ancientbox/ClaudeWS/AncientPantheon/constructors/Pythia`.

Read `apps/pythia/src/connectors/verify/apolloVerify.ts` first — the exact dynamic-import pattern
(`await import("@ouronet/dalos-crypto/registry")`, reach `Apollo` off the registry module) every
new sign-side file in this plan must mirror. `@ouronet/dalos-crypto` is already an `apps/pythia`
dependency (`^4.0.3`) — no package.json change needed for it.

## Wave 1

- [x] T1: Add `@ancientpantheon/pythia-client` as Pythia's third recognized organ — done when:
      `apps/pythia/package.json`'s `dependencies` gains `"@ancientpantheon/pythia-client":
      "^2.3.0"` (run `npm install` at the repo root after editing so the lockfile updates and the
      workspace symlink resolves); `apps/pythia/src/admin/organVersions.ts`'s `ORGAN_PACKAGES`
      array gains one entry: `{ key: "pythia-client", pkg: "@ancientpantheon/pythia-client", label:
      "Pythia" }` (appended after the `khronoton` entry — do not reorder the existing two). No
      other code in that file changes; `readInstalledOrganVersion`/`fetchLatestOrganVersion`/
      `collectOrganVersions` are already generic over `ORGAN_PACKAGES` and need no edits. Tests
      (extend `apps/pythia/src/admin/organVersions.test.ts`, read it first for the existing
      per-organ test style): `collectOrganVersions()` returns exactly 3 entries, in `ORGAN_PACKAGES`
      order, with `pythia-client` as the third; `readInstalledOrganVersion("@ancientpantheon/
      pythia-client")` resolves a real semver string (not `"unknown"`) now that it's an installed
      dependency — proves the workspace resolution actually works, not just that the array grew.
  - files: `apps/pythia/package.json`, `package-lock.json`, `apps/pythia/src/admin/organVersions.ts`, `apps/pythia/src/admin/organVersions.test.ts`

- [x] T2 (RELOCATED after build — see note): `apps/pythia/src/automaton/selfApollo.ts` — Pythia's own dual-Apollo identity:
      generation, sealed storage, and signing, in one module — done when:
      - Exports `interface SelfApolloAccounts { standardAccount: string | null; smartAccount:
        string | null; }`.
      - Exports `class SelfApolloVault` constructed with one arg, a `SealedStore` instance (import
        `type { SealedStore } from "../../codex/sealedStore.js"`; read that file first — `set(name,
        plaintext)`/`get(name)`/`has(name)`, `name` must match `/^[A-Za-z0-9_-]+$/`). Seals each
        half as a JSON string (`{account, priv, publ}`, where `priv`/`publ` are the Apollo
        `KeyPair`'s own field names) under the fixed entry names `"self-apollo-standard"` and
        `"self-apollo-smart"` — do not make these configurable.
      - `async ensureGenerated(): Promise<SelfApolloAccounts>` — for EACH half independently: if
        `store.has(entryName)`, leave it untouched; else dynamically `import("@ouronet/dalos-crypto/
        registry")`, call `registry.Apollo.generateRandom()` **as its own independent call per
        half** (call it once for the standard half, taking ONLY `.standardAddress` +
        `.keyPair`; call it AGAIN, separately, for the smart half, taking ONLY `.smartAddress` +
        `.keyPair` — these are two unrelated random keypairs, never the same `generateRandom()`
        call's two address forms — see design.md's Approach §1 for why), then `store.set(entryName,
        JSON.stringify({account, priv: keyPair.priv, publ: keyPair.publ}))`. Returns the resulting
        `{standardAccount, smartAccount}` (whether freshly generated or already-present) — idempotent,
        safe to call on every admin request.
      - `standardAccount(): string | null` / `smartAccount(): string | null` — read-only accessors
        parsing the sealed JSON's `.account` field, `null` if not yet generated or the store is
        locked/no master key.
      - `createSigner(which: "standard" | "smart"): ApolloSigner` — imports `type { ApolloSigner }
        from "@ancientpantheon/pythia-client"` (T1's new dependency). The returned object's
        `sign({apolloAccount, nonce, rp})` reads the matching sealed keypair, builds the message via
        `buildChallengeMessage({apollo: apolloAccount, nonce, rp})` (import from `"../verify/
        canonicalMessage.js"` — the EXACT existing function the server-side verifier already
        checks against, do not reimplement the message format), signs via
        `registry.Apollo.sign({priv, publ}, message)` (same dynamic-import pattern), and returns
        `{signature}`. Throws a clear error if that half hasn't been generated yet.
      Tests: `ensureGenerated()` called twice returns the SAME two account strings both times (the
      second call generates nothing — assert via a spy/count on a way to detect a fresh
      `generateRandom()` call, e.g. inject the `Apollo` module or count `store.set` calls, which
      must be 0 on the second call); the returned `standardAccount` passes `isStandardApollo()`
      (import from `"../../routes/connectorVerify.js"`) and `smartAccount` passes `isSmartApollo()`;
      calling `ensureGenerated()` when ONLY the standard half already exists (simulate via seeding
      the store directly) generates ONLY the missing smart half, leaving the standard entry's sealed
      content byte-identical; a signature produced by `createSigner("standard").sign(...)` is
      independently verified TRUE by the real `apolloVerify()` (import from `"../verify/
      apolloVerify.js"`) against the matching account's public key and the same nonce/rp — a real
      round-trip proof, not a mocked assertion; `createSigner` on a not-yet-generated half rejects
      with a clear error rather than signing garbage.
  - files (CORRECTED post-build): `apps/pythia/src/automaton/selfApollo.ts`, `apps/pythia/src/automaton/selfApollo.test.ts` — **not** `connectors/self/` as originally planned. `apps/pythia/src/invariants/keylessScanner.ts` bans `generateRandom`/`Apollo.sign`-adjacent symbols everywhere under `src/` EXCEPT any directory literally named `automaton` (the existing "keyed sovereign half" boundary — Codex/Khronoton signing already lives there), enforced by `apps/pythia/tests/keyless-invariant.test.ts`. This was a real gap in the original plan, caught by T2's own build (the full suite failed on the invariant test) — not a scanner bug to weaken. Fix: relocate into `automaton/`, flat alongside the existing `codexStore.ts`/`codexAdmin.ts` (not a new subdirectory), and update every relative import inside the file for the new depth (one level shallower than `connectors/self/`): `../codex/sealedStore.js` (was `../../codex/sealedStore.js`), `../connectors/verify/apolloVerify.js` (was `../verify/apolloVerify.js`), `../connectors/verify/canonicalMessage.js` (was `../verify/canonicalMessage.js`), `../routes/connectorVerify.js` (was `../../routes/connectorVerify.js`). Re-run `npm test -w @ancientpantheon/pythia -- tests/keyless-invariant.test.ts` and the full suite to confirm both the invariant test and `selfApollo.test.ts`'s own 9 tests still pass after the move.

- [x] T3: `apps/pythia/src/connectors/self/inProcessFetch.ts` — the in-process transport shortcut —
      done when: exports `function createInProcessFetch(app: Hono): typeof fetch` (import `type {
      Hono } from "hono"`) returning an async function `(input, init) => app.request(input as
      string | Request | URL, init)` — a direct pass-through to Hono's own `app.request(...)`
      (matches its documented testing-dispatch signature: `(input: Request | string | URL,
      requestInit?: RequestInit) => Response | Promise<Response>`), wrapped in `Promise.resolve(...)`
      only if needed to normalize the `Response | Promise<Response>` return into a strict
      `Promise<Response>` matching `typeof fetch`'s signature. Tests: build a minimal real `Hono`
      app with one `app.get("/ping", (c) => c.json({ok:true}))` route, wrap it with
      `createInProcessFetch`, call the returned function with `"/ping"`, assert the response body is
      `{ok:true}` with status 200 — proves it dispatches through Hono's real router; a second test
      spies on the global `fetch` (e.g. `vi.spyOn(globalThis, "fetch")`) before making the same call
      and asserts the global spy is NEVER invoked — proves no real network call happens.
  - files: `apps/pythia/src/connectors/self/inProcessFetch.ts`, `apps/pythia/src/connectors/self/inProcessFetch.test.ts`

- [x] T4: `apps/pythia/src/admin/routes.ts` — the `SelfConnectorAdminControls` extra + its routes —
      done when: exports a new interface
      ```ts
      export interface SelfConnectorStatus {
        standardAccount: string | null;
        smartAccount: string | null;
        standard: "not-generated" | "pending" | "active";
        smart: "not-generated" | "pending" | "active";
      }
      export interface SelfConnectorAdminControls {
        status(): Promise<SelfConnectorStatus>;
        generate(): Promise<SelfConnectorStatus>;
      }
      ```
      placed alongside the existing `HubAdminControls`/`PythAdminControls`/etc. interfaces (same
      file, same doc-comment density/style — read 2-3 of the existing ones first). `AdminExtras`
      gains an optional `selfConnector?: SelfConnectorAdminControls` field. Inside `registerAdmin`,
      destructure it alongside the other extras and, following the EXACT same `if (x) { ... }`
      conditional-registration pattern every other extra already uses (e.g. `hubNodes`/`versionInfo`
      just above it — mirror their placement, at the end of the function): register `GET
      /admin/self-connector` (gate, `c.json(await selfConnector.status())`) and `POST
      /admin/self-connector/generate` (gate, `c.json(await selfConnector.generate())`). Both
      ancient-gated via the existing `gate` middleware already in scope in that function — no new
      auth mechanism. This task defines the SHAPE only; nothing here imports from `selfApollo.ts`
      or any other Wave-1 file — the real implementation is wired into these interfaces later
      (Wave 3), exactly like every other `*AdminControls` interface here is populated at the
      composition root, not in this file. Tests (extend `apps/pythia/src/admin/routes.test.ts`,
      matching its existing per-extra test style, e.g. how `hubNodes`/`versionInfo` are tested with
      a fake controls object): `GET /admin/self-connector` without the `selfConnector` extra wired
      returns 404 (route not registered) — mirrors how every other optional extra behaves when
      absent; with a fake `selfConnector` extra supplied, `GET /admin/self-connector` (authenticated
      as an `ancient` admin) returns the fake's `status()` result as JSON; `POST
      /admin/self-connector/generate` calls the fake's `generate()` and returns its result;
      unauthenticated (no session) on either route returns 401, matching the existing gate tests'
      pattern.
  - files: `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/routes.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T5: `apps/pythia/src/automaton/selfConnectorLoop.ts` (NOT `connectors/self/` — same keyless-
      invariant reasoning as T2's relocation note above: this file calls `vault.createSigner(...)`
      and drives real signing through it, so it belongs in the keyed `automaton/` zone alongside
      `selfApollo.ts`, flat next to `codexStore.ts`/`codexAdmin.ts`) — composes Pythia's two
      self-connectors + a periodic refresh loop — done when: mirrors `apps/pythia/src/stats/
      usageReporter.ts`'s exact class shape (read it first — `tick()`/`start()`/`stop()`, a
      `private timer: ReturnType<typeof setInterval> | undefined`, `setInterval(...).unref()` in
      `start()`). Exports:
      ```ts
      export interface SelfConnectorLoopOptions {
        baseUrl: string; // required by Transport's constructor; never actually dialed — see inProcessFetch
        fetchImpl: typeof fetch; // T3's createInProcessFetch(app) result
        vault: SelfApolloVault; // T2
        intervalMs?: number; // default 3 * 60 * 60 * 1000 (3h) — matches the ephemeral secret's own TTL, no reason to poll faster than the secret it's refreshing can even go stale
      }
      export type SelfConnectorHalfStatus =
        | { status: "not-generated" }
        | { status: "pending" }
        | { status: "active"; secret: string; expiresAt: number };
      ```
      `class SelfConnectorLoop` constructed with `SelfConnectorLoopOptions`. Internally, lazily
      constructs (on first `tick()` where the relevant account exists) one `PythiaConnector` (from
      `@ancientpantheon/pythia-client`, T1's dependency) per half, each with `apolloAccount:
      vault.standardAccount()!` / `vault.smartAccount()!`, `signer: vault.createSigner("standard" |
      "smart")`, `fetchImpl: options.fetchImpl`, `baseUrl: options.baseUrl` — constructed ONCE and
      reused across ticks (not rebuilt every tick), same as `usageReporter`'s stateful fields.
      `async tick(): Promise<void>` — for each half whose account exists, calls
      `connector.ensureSecret()`, catching and `console.error`-logging any thrown
      `PythiaConnectorError` per half independently (one half's failure must never block the
      other's tick, mirroring `usageReporter.tick()`'s per-branch isolation). `start()`/`stop()` —
      identical shape to `usageReporter.ts`. `status(): { standard: SelfConnectorHalfStatus; smart:
      SelfConnectorHalfStatus }` — reads each connector's last-known result WITHOUT triggering a
      new network/signer call (cache a `private lastStandard`/`lastSmart` field, updated at the end
      of each successful `tick()`'s `ensureSecret()` call; `{status:"not-generated"}` when the
      account doesn't exist yet and no connector has been constructed). Tests: with a real in-memory
      `SealedStore` + real `SelfApolloVault` (T2) that has generated both halves, and a fake/real
      Hono app wired with `createInProcessFetch` (T3) serving stub `/connectors/auth/{challenge,
      verify}` routes returning a 200 secret for both — `tick()` drives both connectors to
      `{status:"active"}`, reflected in `status()`; `status()` before any `tick()` call, or before
      generation, returns `{status:"not-generated"}` for a half with no account; `start()`/`stop()`
      set/clear a real timer without throwing (assert via `vi.useFakeTimers()` + `vi.advanceTimersByTime`
      that `tick()`-driven work happens roughly every `intervalMs`, mirroring `usageReporter.test.ts`'s
      own timer-testing pattern if it has one — read it first).
  - files: `apps/pythia/src/connectors/self/selfConnectorLoop.ts`, `apps/pythia/src/connectors/self/selfConnectorLoop.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T6: `apps/pythia/src/index.ts` — composition-root wiring — done when: constructs `const
      selfApolloVault = new SelfApolloVault(sealedVault)` (reusing the SAME `sealedVault` instance
      already exported above in this file — new entry names `"self-apollo-standard"`/
      `"self-apollo-smart"` cannot collide with any existing vault entry, per T2's fixed naming);
      constructs `const selfConnectorLoop = new SelfConnectorLoop({ baseUrl: "http://pythia.self"
      /* never dialed — see inProcessFetch.ts's doc comment */, fetchImpl:
      createInProcessFetch(app), vault: selfApolloVault })` (placed after `export const app = new
      Hono();` since `createInProcessFetch` needs the real `app` instance); calls
      `selfConnectorLoop.start()` alongside the other `.start()` calls already grouped near the
      bottom of this file (`dualLinkCache.start()`, `ephemeralKeyStore.start()`,
      `pendingActivationTracker.start()` — add it to that same block). Inside the existing `if
      (oidcConfig) { registerAdmin(app, oidcConfig, connectorStore, { ... }) }` block, add
      `selfConnector: { status: async () => { const accounts = { standardAccount:
      selfApolloVault.standardAccount(), smartAccount: selfApolloVault.smartAccount() }; const loop
      = selfConnectorLoop.status(); return { ...accounts, standard: loop.standard.status ===
      "active" ? "active" : accounts.standardAccount ? "pending" : "not-generated", smart:
      loop.smart.status === "active" ? "active" : accounts.smartAccount ? "pending" :
      "not-generated" }; }, generate: async () => { await selfApolloVault.ensureGenerated(); return
      selfConnector.status(); } }` to the extras object (exact field derivation may differ slightly
      once written against T5's real `status()` return shape — the DONE-WHEN condition is behavioral,
      not textual, see below).

      Also create `apps/pythia/src/selfConnectorIntegration.test.ts` — a NEW dedicated
      composition-level integration test (no `index.ts` test file exists today, and `index.ts`
      itself has import-time side effects — booting a real server config, reading env — that make
      importing it directly in a test impractical; instead this test manually wires the same real
      pieces `index.ts` wires, mirroring how `packages/pythia-client/src/connectorIntegration.test.ts`
      and `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.test.ts`'s own "integration"
      test each construct real collaborators rather than importing the app wholesale — read both
      first). It builds: a real `Hono` app with `registerConnectorAuth` (real `AuthNonceStore`,
      `EphemeralKeyStore`, a `DualLinkCache` seeded via its injectable `poll` to report an EMPTY
      active set — i.e. neither of Pythia's own accounts is active yet, the realistic starting
      state), a real `PendingActivationTracker`, a real `SelfApolloVault` (backed by a real
      `SealedStore` pointed at a temp dir, with a fixed test master key), a real `SelfConnectorLoop`
      wired with `createInProcessFetch(app)` (T3) and a stub `readApolloPublicKey`/
      `readApolloCounterpart` pair the test controls directly (mirrors how `readApolloPublicKeyForAuth`/
      `readApolloCounterpartForAuth` closures work in `index.ts`, but returning canned answers
      instead of dialing real chain nodes). Test: call `selfApolloVault.ensureGenerated()`, then
      drive `selfConnectorLoop.tick()` — asserts BOTH of Pythia's own accounts end up recorded in
      the REAL `pendingActivationTracker` (i.e. `pendingActivationTracker.beginActivation()` returns
      a non-null pair matching Pythia's own standard/smart accounts) purely as a result of the two
      real challenge→sign→verify round trips running in-process — proving Topic 2's existing
      pairing mechanism picks up Pythia's own self-proofs with zero self-case branching anywhere in
      `connectorAuth.ts`/`pendingActivationTracker.ts`. A second assertion feeds that pair's token
      through a real `createDualLinkActivateResolver(pendingActivationTracker)`'s `resolve()` (from
      `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.js`) and confirms it returns a
      non-empty plan naming exactly those two accounts (stops short of actually signing/submitting
      the on-chain tx — that's the generic Khronoton engine layer, already covered by its own
      tests, out of scope here).

      `npm test -w @ancientpantheon/pythia` full suite green; `npm run typecheck
      --workspace=@ancientpantheon/pythia` clean; `npm run build --workspace=@ancientpantheon/pythia`
      clean; a behavioral test (in `apps/pythia/src/admin/routes.test.ts`, extending T4's fakes with
      the real `selfApolloVault`/`selfConnectorLoop` this task wires) hitting `GET
      /admin/self-connector` (authenticated) on the fully-wired extras returns
      `standardAccount: null, smartAccount: null, standard: "not-generated", smart: "not-generated"`
      before generation, and hitting `POST /admin/self-connector/generate` then `GET
      /admin/self-connector` again shows both accounts populated with `standard`/`smart` no longer
      `"not-generated"`.
  - files: `apps/pythia/src/index.ts`, `apps/pythia/src/selfConnectorIntegration.test.ts`, `apps/pythia/src/admin/routes.test.ts`

- [x] T7: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js` — minimal self-connector
      status panel — done when: a new read-only section (following the existing panel markup/JS
      pattern used by the "Security" panel — read that panel's HTML block and its corresponding
      `admin.js` fetch/render function first, mirror the structure exactly: a framed card, a
      `fetch("/admin/self-connector")` on load, rendered fields) shows: the Standard account string
      (or "not yet generated"), the Smart account string (or "not yet generated"), each half's
      status (`not-generated` / `pending` / `active`) as a short label, and — only when at least one
      account is `"not-generated"` — a "Generate" button that `POST`s `/admin/self-connector/
      generate` and re-fetches status on success. No STOA-payment/deploy/link UI — this panel is
      read-only status plus the one generate action, per design.md's explicit manual/automated
      split. Lowest priority in this plan — if time runs out, T1-T6 alone already ship the full
      backend capability; this task only adds visibility. Done when: manually loading `/admin` in a
      browser (or, for automated verification, a DOM-level test if `admin.js` already has any —
      check for an existing test file for `admin.js` before deciding whether to add one; if none
      exists for any other panel, none is required here either, matching the established
      convention) shows the new section, and clicking Generate on a fresh (ungenerated) state
      results in the account strings appearing without a page reload.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`
