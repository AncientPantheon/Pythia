## Wave 1

- [x] T1: `packages/pythia-client/src/maskSecret.ts` — a tiny, pure, dependency-free masking helper —
      done when: exports `export function maskSecret(secret: string): string` returning
      `` `${secret.slice(0, 7)}...${secret.slice(-7)}` `` for any string of length ≥ 14 (the shortest
      real ephemeral secret, `pk_eph_` (7 chars) + at least a handful of base64url chars, is always
      well over this), and for a string SHORTER than 14 chars returns the string unchanged (never
      produces overlapping/negative-slice garbage — e.g. `maskSecret("short")` returns `"short"`, not
      `"short...t"` or similar). Exported from `packages/pythia-client/src/index.ts` alongside the
      existing named exports (one name per line, matching the file's established convention).
      Tests (TDD, write first) in `packages/pythia-client/src/maskSecret.test.ts`:
      - A realistic `pk_eph_...`-shaped 39-char secret masks to exactly `first7...last7` — assert the
        exact string, not just a length/shape regex.
      - A string exactly 14 chars long (the boundary) masks normally (first 7 + `...` + last 7, no
        overlap since `slice(0,7)` and `slice(-7)` don't intersect at exactly 14).
      - A string of 13 chars (one under the boundary) is returned UNCHANGED, not masked.
      - The empty string is returned unchanged (not `"..."` or an error).
  - files: `packages/pythia-client/src/maskSecret.ts`, `packages/pythia-client/src/maskSecret.test.ts`, `packages/pythia-client/src/index.ts`

- [x] T2: Differentiate the ephemeral-secret TTL by identity — done when:
      `apps/pythia/src/connectors/auth/ephemeralKeyStore.ts`'s single `EPHEMERAL_SECRET_TTL_MS`
      constant (3h) splits into two exported constants: `DEFAULT_EPHEMERAL_SECRET_TTL_MS = 6 * 60 *
      60 * 1000` and `SELF_EPHEMERAL_SECRET_TTL_MS = 24 * 60 * 60 * 1000`. `EphemeralKeyStore.issue()`
      gains an optional second parameter: `issue(apolloAccount: string, ttlMs: number =
      DEFAULT_EPHEMERAL_SECRET_TTL_MS)`, using `ttlMs` in place of the old fixed constant when
      computing `expiresAt`. `apps/pythia/src/routes/connectorAuth.ts`'s `ConnectorAuthDeps` gains an
      optional `isSelfAccount?: (apolloAccount: string) => boolean`; the verify handler's existing
      final line `const { secret, expiresAt } = deps.ephemeralKeyStore.issue(apolloAccount);` becomes
      `deps.ephemeralKeyStore.issue(apolloAccount, deps.isSelfAccount?.(apolloAccount) ?
      SELF_EPHEMERAL_SECRET_TTL_MS : DEFAULT_EPHEMERAL_SECRET_TTL_MS)` (import both constants from
      `../connectors/auth/ephemeralKeyStore.js`). No change to the existing `isActiveAccount` gate
      (`dualLinkCache.isActiveAccount`) — already confirmed sufficient; this task only changes which
      TTL is passed once that gate is already satisfied.
      Tests (TDD, write first):
      - `apps/pythia/src/connectors/auth/ephemeralKeyStore.test.ts`: update the existing TTL-boundary
        test (currently imports `EPHEMERAL_SECRET_TTL_MS`) to import `DEFAULT_EPHEMERAL_SECRET_TTL_MS`
        instead, asserting `issue()` called with no `ttlMs` uses the new 6h default. New test:
        `issue(account, SELF_EPHEMERAL_SECRET_TTL_MS)` produces an `expiresAt` ~24h out (compare
        against an injected `clock`), distinctly longer than a sibling `issue(account)` call's ~6h
        default, using the same injected `clock` for both so the comparison is exact, not
        time-fuzzy.
      - `apps/pythia/src/routes/connectorAuth.test.ts`: new test in the existing "connector auth"
        describe block — `appWith` gains an optional `isSelfAccount` passthrough to
        `registerConnectorAuth`; a verify for an account where `isSelfAccount` returns `true` gets a
        secret whose `expiresAt` is within a few seconds of `Date.now() + SELF_EPHEMERAL_SECRET_TTL_MS`
        (import the constant, assert a tight bound, e.g. `toBeGreaterThan(Date.now() +
        SELF_EPHEMERAL_SECRET_TTL_MS - 5000)` and `toBeLessThanOrEqual(Date.now() +
        SELF_EPHEMERAL_SECRET_TTL_MS)`); a sibling verify for an account where `isSelfAccount` is
        omitted (or returns `false`) gets a secret whose `expiresAt` is within the same tight bound of
        `Date.now() + DEFAULT_EPHEMERAL_SECRET_TTL_MS`, and is clearly less than the self case's
        `expiresAt` (direct comparison between the two responses, not just two separate bound checks).
  - files: `apps/pythia/src/connectors/auth/ephemeralKeyStore.ts`, `apps/pythia/src/connectors/auth/ephemeralKeyStore.test.ts`, `apps/pythia/src/routes/connectorAuth.ts`, `apps/pythia/src/routes/connectorAuth.test.ts`

- [x] T3: `SelfApolloVault` gains dual-link-key custody; `SelfConnectorLoop` evolves to wrap
      `DualLinkConnector` — done when:
      `apps/pythia/src/automaton/selfApollo.ts`: a third sealed entry name added to `ENTRY_NAMES`-
      adjacent state — `const DUAL_LINK_KEY_ENTRY = "self-dual-link-key";` (plain string, not the
      `SealedHalf` JSON shape the two account halves use — this is a public composite account
      string, not key material). Two new public methods on `SelfApolloVault`:
      `dualLinkKey(): string | null` (reads `this.store.get(DUAL_LINK_KEY_ENTRY)`, `null` if absent)
      and `setDualLinkKey(key: string): void` — calls `splitDualLinkKey(key)` (import from
      `@ancientpantheon/pythia-client`, already published as of v2.5.0) and throws (propagating
      `splitDualLinkKey`'s own `PythiaConnectorValidationError` unchanged for a malformed key, OR a
      new `Error` — `` `self-apollo: pasted dual-link-key's standard half (${standardApollo}) does
      not match this vault's own standard account (${this.standardAccount()})` `` (and the mirror
      message for the smart half) — when the key is well-formed but doesn't match BOTH of
      `this.standardAccount()`/`this.smartAccount()` exactly). Only on a full match does it call
      `this.store.set(DUAL_LINK_KEY_ENTRY, key)`.
      `apps/pythia/src/automaton/selfConnectorLoop.ts`: `SelfConnectorHalfStatus` gains a 4th
      variant: `{ status: "not-linked" }` between `"not-generated"` and `"pending"` in the type union.
      `SelfConnectorLoop` drops its own `standardConnector`/`smartConnector`/`connectorFor` private
      machinery entirely; gains one lazily-built private field:
      `private dualLinkConnector: DualLinkConnector | null = null;`. `tickHalf`'s per-half branching
      is replaced: `tick()` now, if `this.dualLinkConnector` is null, attempts to build one —
      `vault.dualLinkKey()` returning `null` means still nothing to do (no-op, matches today's
      "account not generated" skip, but now gated on the KEY not the accounts); once a key exists,
      constructs `new DualLinkConnector({ dualLinkKey: vault.dualLinkKey()!, baseUrl: this.baseUrl,
      standardSigner: vault.createSigner("standard"), smartSigner: vault.createSigner("smart"),
      fetchImpl: this.fetchImpl, intervalMs: this.intervalMs })` ONCE, caches it in
      `this.dualLinkConnector`, then calls `await this.dualLinkConnector.tick()` every call
      thereafter (never rebuilding). `status()` maps `DualLinkConnector.status()`'s
      `{standard, smart}` (each `{status:"pending"}` or `{status:"active", secret, expiresAt}`) onto
      `SelfConnectorHalfStatus`: no account for that half yet → `{status:"not-generated"}`; account
      exists but `this.dualLinkConnector` is still null (no key set) → `{status:"not-linked"}`;
      connector exists and that half's `DualLinkHalfStatus` is `"pending"` → `{status:"pending"}`;
      `"active"` passes `secret`/`expiresAt` straight through. `start()`/`stop()` keep their existing
      `setInterval`-based shape unchanged (still call `this.tick()`, which now internally
      lazy-builds).
      Tests (TDD, write first):
      - `apps/pythia/src/automaton/selfApollo.test.ts`: new `describe("SelfApolloVault —
        dualLinkKey")` block — `dualLinkKey()` is `null` before any `setDualLinkKey` call;
        `setDualLinkKey` with a well-formed key whose halves exactly match the vault's own generated
        accounts succeeds, and `dualLinkKey()` then returns that exact key; `setDualLinkKey` with a
        malformed key (wrong length) throws `PythiaConnectorValidationError` (imported from
        `@ancientpantheon/pythia-client`) and `dualLinkKey()` remains `null` afterward; `setDualLinkKey`
        with a well-formed key whose standard half does NOT match the vault's own generated standard
        account throws an `Error` whose message contains "does not match" and names which half, and
        `dualLinkKey()` remains `null` afterward (construct this fixture as: generate the vault's real
        pair, then build a dual-link-key using a DIFFERENT, independently-generated standard half
        joined with the vault's OWN real smart half via `DUAL_LINK_BAR` — proving the check is
        per-half, not just "any mismatch anywhere").
      - `apps/pythia/src/automaton/selfConnectorLoop.test.ts`: existing `buildStubApp` helper is
        reused unchanged (it already serves canned challenge/verify responses keyed by
        `apolloAccount`, which is exactly what the internal `DualLinkConnector` will call through
        `createInProcessFetch`). New/updated behavior to cover: `status()` reports `"not-linked"` for
        BOTH halves once the vault is generated but `setDualLinkKey` has never been called (replacing
        the old "reports not-generated for both halves" expectation for the post-generation,
        pre-link case — the existing "before ANY generation" test, asserting `"not-generated"`, stays
        as-is since that case is unchanged); after `vault.setDualLinkKey(...)` with the vault's own
        real matching key, `tick()` against the stub drives both halves to `"active"` exactly as the
        existing "after a successful tick" test already asserts (that test now needs a
        `vault.setDualLinkKey(...)` call inserted before `loop.tick()`, using
        `` `${standardAccount}${DUAL_LINK_BAR}${smartAccount}` `` built from the fixture's own
        generated accounts — import `DUAL_LINK_BAR` from `@ancientpantheon/pythia-client`); a NEW
        test drives `tick()` with NO `setDualLinkKey` call ever made and confirms it resolves without
        throwing and `status()` still reports `"not-linked"` for both halves (the no-op-until-linked
        path); the existing "reuses the SAME connector across ticks" test is updated to assert
        against the new single internal `DualLinkConnector` being built exactly once (still provable
        via verify-call-count across two ticks, same technique, just no longer per-half
        `standardConnector`/`smartConnector` — a single shared instance now). The existing
        "isolates a half's verify failure" and "a half reported PENDING" tests both still apply
        conceptually (per-half isolation is now `DualLinkConnector`'s own job, already proven in
        `packages/pythia-client`) — keep them, with `setDualLinkKey` inserted, confirming the
        delegation actually preserves that behavior end-to-end through `SelfConnectorLoop`, not just
        asserting it once in the SDK's own suite.
  - files: `apps/pythia/src/automaton/selfApollo.ts`, `apps/pythia/src/automaton/selfApollo.test.ts`, `apps/pythia/src/automaton/selfConnectorLoop.ts`, `apps/pythia/src/automaton/selfConnectorLoop.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T4: `apps/pythia/src/admin/routes.ts` — `SelfConnectorAdminControls.link()` + reshaped
      `SelfConnectorStatus` — done when:
      New interface `SelfConnectorHalfView`:
      ```ts
      export interface SelfConnectorHalfView {
        state: "not-generated" | "not-linked" | "pending" | "active";
        maskedSecret: string | null; // only non-null when state === "active"
        expiresAt: number | null;    // only non-null when state === "active"
      }
      ```
      `SelfConnectorStatus` (existing interface) changes: `standard`/`smart` fields change type from
      the current bare `"not-generated" | "pending" | "active"` string union to
      `SelfConnectorHalfView`; a new field `dualLinkKey: string | null` is added (echoes the
      currently-set key — not sensitive, just the public composite account string). Both changes are
      breaking to the existing shape, applied here directly (this is Pythia's own internal admin
      contract, not a published API — no deprecation period needed, matching how this codebase
      treats every other admin-internal type). `SelfConnectorAdminControls` gains: `link(dualLinkKey:
      string): Promise<SelfConnectorStatus>`. `registerAdmin`'s existing `if (selfConnector) { ... }`
      block gains a third route: `app.post("/admin/self-connector/link", gate, async (c) => { const
      body = (await c.req.json().catch(() => null)) as { dualLinkKey?: unknown } | null; const
      dualLinkKey = typeof body?.dualLinkKey === "string" ? body.dualLinkKey : ""; try { return
      c.json(await selfConnector.link(dualLinkKey)); } catch (err) { return c.json({ error: err
      instanceof Error ? err.message : "invalid dual-link-key" }, 400); } });` (mirrors every other
      route's `{error: string}` 400 shape; the try/catch is needed here specifically because
      `link()`'s real implementation, wired in T5, calls `vault.setDualLinkKey()` which THROWS on a
      bad key rather than returning a result type — every sibling route in this file that can fail
      validation, e.g. `/admin/connectors`, instead checks and returns 400 directly without a
      try/catch, but none of those call a throwing vault method, so this route's shape is
      intentionally different, not an inconsistency).
      Tests (TDD, write first) in `apps/pythia/src/admin/routes.test.ts`:
      - Update the existing `FIXTURE` (in the `"admin /admin/self-connector[/generate] —
        SelfConnectorAdminControls extra"` describe block) to the new `SelfConnectorStatus` shape
        (`standard`/`smart` as `SelfConnectorHalfView` objects, plus `dualLinkKey`), and add a
        `link: vi.fn(async () => ({ ...FIXTURE }))` to the fake `selfConnector` object in `makeApp`.
        The three existing tests in that block (GET returns fixture, POST /generate returns fixture,
        401s when unauthenticated) continue to pass against the updated fixture shape unchanged in
        intent.
      - New test: `POST /admin/self-connector/link` with a JSON body calls the fake's `link()` with
        exactly the posted `dualLinkKey` string and returns its result as JSON (200).
      - New test: `POST /admin/self-connector/link` 401s when unauthenticated (mirrors the existing
        401 test's pattern for the other two routes).
      - New test: when the fake's `link()` rejects with `new Error("some validation message")`, the
        route returns 400 with `{ error: "some validation message" }` — proving the try/catch
        actually surfaces the thrown message, not a generic fallback.
      - The existing `"admin /admin/self-connector[/generate] — REAL SelfApolloVault +
        SelfConnectorLoop wiring"` describe block's `makeRealApp` helper mirrors — deliberately, per
        its own doc comment — the composition root's real closure shape, so it must be updated
        HERE, in this same task, not deferred: T1 (`maskSecret`) and T3 (`SelfApolloVault`/
        `SelfConnectorLoop`'s new shapes) are both already available (earlier waves), so this is not
        a forward reference. Rewrite `makeRealApp`'s inline `status()` helper to build the new
        `SelfConnectorStatus` shape the same way T5 will wire it in `index.ts` (map each half's
        `SelfConnectorHalfStatus` to a `SelfConnectorHalfView`, `maskSecret`-ing the secret when
        active, `null`s otherwise; add `dualLinkKey: vault.dualLinkKey()`), and add a real `link:
        async (dualLinkKey) => { vault.setDualLinkKey(dualLinkKey); return status(); }` to the
        `selfConnector` extras object passed to `registerAdmin`. Update the existing test's
        assertions to the new shape (`standard`/`smart` as `{state, maskedSecret, expiresAt}`
        objects). Add one new test in this block: after `POST /admin/self-connector/generate`, `POST
        /admin/self-connector/link` with the real generated pair's own accounts joined via
        `DUAL_LINK_BAR` (import from `@ancientpantheon/pythia-client`) succeeds (200), and the
        subsequent `GET /admin/self-connector` reports `dualLinkKey` equal to what was posted and
        both halves' `state` as `"not-linked"` transitioning... — precisely: since no in-process
        stub connector-auth server is wired for THIS describe block (it only proves
        generate/link/status persistence through the real classes, not a full tick cycle — that's
        `selfConnectorLoop.test.ts`'s job, via T3), assert `state` is `"pending"` for both halves
        immediately after linking (matches `SelfConnectorLoop.status()`'s mapping once
        `vault.dualLinkKey()` is non-null but no tick has run yet — NOT `"not-linked"`, since a key
        IS now set; re-check this exact expected string against T3's actual `status()` mapping logic
        once T3 is built, adjusting this assertion if the mapping differs).
  - files: `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/routes.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T5: `apps/pythia/src/index.ts` — composition-root wiring — done when:
      The `registerConnectorAuth(app, { ... })` call gains `isSelfAccount: (account) => account ===
      selfApolloVault.standardAccount() || account === selfApolloVault.smartAccount(),`. The
      `selfConnectorStatus()` local async function is rewritten to build the new
      `SelfConnectorStatus` shape: reads `selfConnectorLoop.status()` (now returning the T3-evolved
      `SelfConnectorHalfStatus` union including `"not-linked"`), maps each half to a
      `SelfConnectorHalfView` — `state` copied through 1:1 from the loop's `status` field;
      `maskedSecret`/`expiresAt` are `maskSecret(loop half.secret)`/`loop half.expiresAt` when
      `status === "active"`, else both `null` (import `maskSecret` from
      `@ancientpantheon/pythia-client`, published in T1). Adds `dualLinkKey: selfApolloVault
      .dualLinkKey()` to the returned object. The `selfConnector` extras object (inside
      `registerAdmin(...)`'s options) gains `link: async (dualLinkKey) => { selfApolloVault
      .setDualLinkKey(dualLinkKey); return selfConnectorStatus(); }` (synchronous
      `setDualLinkKey` throws propagate straight out of this async function as a rejection, which
      T4's route already catches). This is production code mirroring the SAME shape T4's
      `routes.test.ts` "REAL wiring" describe block already built and tested inline against the real
      `SelfApolloVault`/`SelfConnectorLoop` classes — this task's `index.ts` change has no dedicated
      test of its own (index.ts has no test-import surface, per that describe block's own doc
      comment), so correctness here rests on matching T4's already-tested reference shape exactly.
      Verification: `npm test -w @ancientpantheon/pythia` full suite green (`versionConsistency.test.ts`
      included though its assertions are unaffected until T7); `npm run typecheck -w
      @ancientpantheon/pythia` clean; `apps/pythia/src/selfConnectorIntegration.test.ts` (the existing
      end-to-end proof that Topic 2 [connector-activation-resolver]'s real tracker picks up
      self-proofs) still passes unmodified — confirms this rewiring didn't regress that path.
  - files: `apps/pythia/src/index.ts`

- [x] T6: `apps/pythia/public/admin.html` + `apps/pythia/public/admin.js` — paste-in "Link" control +
      masked secret/countdown display — done when:
      `admin.html`'s existing `<section class="admin-view" data-view="self-connector" hidden>` block
      (currently lines ~261-277) gains, after the two `.sec-status` divs and before the existing
      `.conn-actions`/Generate button: a `<div class="conn-actions"><input type="text"
      id="selfconn-link-input" placeholder="Paste the active dual-link-key" class="input">
      <button type="button" id="selfconn-link-btn" class="btn btn--primary">Link</button></div><p
      class="conn-error" id="selfconn-link-error" hidden></p>`, and — inside each of the two
      `.sec-status`/`.sec-status-smart` divs, after the existing badge+account spans — a new `<span
      class="sec-fingerprint" id="selfconn-standard-secret"></span>` / `id="selfconn-smart-secret"`
      (masked secret + countdown text, populated by JS; empty when not active).
      `admin.js`: `selfConnectorHalfView(state)` — currently takes the OLD bare-string state and
      returns `{cls, text}` — is renamed to a helper that instead reads a
      `SelfConnectorHalfView`-shaped object (`{state, maskedSecret, expiresAt}`) and returns
      `{cls, text}` for the badge exactly as today PLUS the countdown text for the new secret span:
      add a case for `"not-linked"` → `{cls: "sec-badge--warn", text: "Not linked"}` (new, between
      "Not generated" and "Pending" in severity). `renderSelfConnector(st)` is updated: reads
      `st.standard.state`/`st.smart.state` (not the old bare string) for the badge; when a half's
      `state === "active"`, sets that half's new secret span's text to
      `` `${maskedSecret} — expires in ${formatCountdown(expiresAt - Date.now())}` `` (new helper
      `formatCountdown(ms)` returning e.g. `"23h 58m"` for ≥1h remaining, `"42m 10s"` under 1h,
      `"expired"` for `ms <= 0`); when not active, clears that span's text. A new module-level
      `setInterval(() => { const st = lastSelfConnectorStatus; if (st) renderSelfConnector(st); },
      1000)` re-renders the countdown every second off the LAST FETCHED status (a new module-level
      `let lastSelfConnectorStatus = null;` set at the top of `renderSelfConnector`, so the 1s tick
      never issues a network call — only `loadSelfConnector()`'s existing fetch does that, on view
      load) — this loop is registered once, guarded so it's harmless if the self-connector view is
      never opened (start it inside `wireSelfConnector()`, which the existing admin.js init sequence
      already calls once at startup, same lifecycle as the Generate button's own listener). `
      wireSelfConnector()` gains a second listener on `#selfconn-link-btn`, mirroring the existing
      Generate button's disable-on-click / error-render / re-enable-in-finally shape exactly, POSTing
      `{ dualLinkKey: <input value, trimmed> }` to `/admin/self-connector/link`; a non-ok response
      renders `#selfconn-link-error`'s text from the response body's `error` field when present (falls
      back to a generic message if the body isn't JSON/has no `error` field — mirrors no existing
      route's exact pattern 1:1 since this is the first admin form here that surfaces a
      server-supplied validation message rather than a fixed string, but follows the same
      disable/error-span/finally shape as every sibling form).
      Verification (no automated test harness exists for this file, matching the existing
      self-connector panel's own convention — confirmed by grepping this repo for any `admin.js`
      test file, none exist): read the final `admin.html`+`admin.js` diff and confirm every new
      element `id` referenced in `admin.js` has a matching `id` in `admin.html` (a mismatched id is
      this file's single most common real bug class, per the existing code's own
      `document.getElementById(...)` + `if (el) ...` defensive-null-check pattern throughout), and
      that the Link button's fetch/error/finally shape is byte-for-byte structurally parallel to the
      existing Generate button's (same disable-before-fetch, same finally-re-enable, same
      hidden-toggle error span pattern).
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

## Wave 4 (depends on Wave 3)

- [x] T7: Version bump + changelogs + README — done when: root `package.json`,
      `apps/pythia/package.json`, `apps/pythia/src/version.ts`, `packages/pythia-client/package.json`
      all bump to the same next version (confirm the current version at build time — after v2.5.0,
      this is the next minor, since both the TTL/UI changes and the new `maskSecret` export are
      additive, no breaking change to any existing PUBLISHED contract — `SelfConnectorStatus`'s
      reshape is internal-admin-only, not a published package export). `packages/pythia-client/
      CHANGELOG.md` gains a new top entry documenting `maskSecret`. `CHANGELOG.md` at the repo root
      gains a matching `## [x.y.z]` entry documenting the full topic: differentiated TTLs, the
      paste-in Link control, masked-secret+countdown display. `packages/pythia-client/README.md`'s
      `## Status` line + a new `**vx.y.z**` version-history paragraph (mentioning `maskSecret`).
      `package-lock.json` regenerated via `npm install --package-lock-only`. Dry-run `publish.yml`'s 3
      documentation-gate greps locally against the new version string (README `## Status` line,
      README `**vX.Y.Z**` version-history paragraph, `CHANGELOG.md` first `##` heading) — all three
      must pass. `npm run typecheck -w @ancientpantheon/pythia-client`, `npm test -w
      @ancientpantheon/pythia-client`, `npm run build -w @ancientpantheon/pythia-client` all clean.
      `npm test -w @ancientpantheon/pythia` (whole-repo suite, includes `versionConsistency.test.ts`)
      green — confirms all four version-bearing files and the root CHANGELOG's newest entry agree.
  - files: `package.json`, `apps/pythia/package.json`, `apps/pythia/src/version.ts`, `packages/pythia-client/package.json`, `CHANGELOG.md`, `packages/pythia-client/CHANGELOG.md`, `packages/pythia-client/README.md`, `package-lock.json`

- [x] T8: Update the Pantheon architecture handoff doc — done when:
      `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` (repo root
      `/home/ancientbox/ClaudeWS/AncientPantheon/websites/Pantheon`) gains a new section describing
      the now-PROVEN pattern, replacing any earlier, more speculative wording about the dual-link-key
      flow with what actually shipped: (1) how a consumer obtains an active dual-link-key (deploy via
      Codex, then either raw `C_Link` or Pythia's browser Link-verify flow — unchanged from this
      doc's existing §2d correction, just cross-referenced, not rewritten); (2) constructing a
      `DualLinkConnector` (`@ancientpantheon/pythia-client`) with the pasted key + one `ApolloSigner`
      per half; (3) wiring `keyProvider()` into `PythiaClient`; (4) for any UI a consumer builds
      around this, using the published `maskSecret()` helper + `status().standard.expiresAt` (or
      `.smart`) for a masked-secret-plus-countdown display — citing Pythia's own Self Connector admin
      panel (`apps/pythia/public/admin.{html,js}`, this topic) as the concrete, working reference
      implementation of exactly this pattern. `docs/pantheonic-architecture/CHANGELOG.md` gains a
      matching entry. This task's own completion report states the exact filename
      (`organs/06-pythia-client-wire-in.md`) so the user can hand it to a Mnemosyne-side agent.
  - files: `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md`, `websites/Pantheon/docs/pantheonic-architecture/CHANGELOG.md`
