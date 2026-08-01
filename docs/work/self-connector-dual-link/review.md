# self-connector-dual-link — Review

Scope: all 8 plan.md tasks (Topic 2 of `pythia-dual-link-connector`) — `packages/pythia-client/src/
{maskSecret,index}.ts(+.test)`, `apps/pythia/src/connectors/auth/ephemeralKeyStore.ts(+.test)`,
`apps/pythia/src/routes/connectorAuth.ts(+.test)`, `apps/pythia/src/automaton/
{selfApollo,selfConnectorLoop}.ts(+.test)`, `apps/pythia/src/admin/routes.ts(+.test)`,
`apps/pythia/src/index.ts`, `apps/pythia/public/admin.{html,js}`, the version bump to 2.6.0 (4
files + both CHANGELOGs + README), and `websites/Pantheon/docs/pantheonic-architecture/
organs/06-pythia-client-wire-in.md` + its CHANGELOG. This topic makes Pythia's own admin panel the
proving ground for the exact `DualLinkConnector` mechanism a future Mnemosyne integration will use,
so weighted correctness (does the self-derivation fix actually preserve every real capability it
touches) and test-coverage (is `index.ts`'s composition-root wiring — which has no test file of its
own — actually verified anywhere) heavily, alongside the usual security/conventions passes.

## Mid-build correction (found during T5's build, before any review lens ran)

T3's first version gated `SelfConnectorLoop`'s internal `DualLinkConnector` construction on
`vault.dualLinkKey()` (the operator-pasted key) being set. Building T5 (index.ts wiring) surfaced
that this broke a real, already-shipped capability: `apps/pythia/src/selfConnectorIntegration.test.ts`
(from the earlier `connector-activation-resolver` topic) proves ownership of a NOT-YET-linked pair
by ticking immediately after generation, to feed `PendingActivationTracker` — a flow with no
dual-link-key to paste yet by definition. **Root cause:** `SelfApolloVault` always deterministically
knows both of its own accounts the moment they're generated — it never actually needs to be TOLD
its own dual-link-key, unlike an arbitrary external consumer. **Fix:** `SelfConnectorLoop` now
self-derives its own key (`standard + DUAL_LINK_BAR + smart`) from the vault's two known accounts
the moment both exist, never waiting on a paste. `setDualLinkKey()`/the Link UI control remain a
real, useful confirmation/validation action (immediate rejection of a key that doesn't match this
vault's own accounts) — just not a functional prerequisite. Full rationale in
`selfConnectorLoop.ts`'s `dualLinkConnector` field doc comment. This correction predates the review
round below but is recorded here since two review findings (correctness HIGH, test-coverage LOW)
trace directly back to it.

## Round 1 — full-scope pass (correctness / security / conventions / tests lenses)

- **[HIGH → MEDIUM on adversarial validation] `SelfConnectorHalfView`'s doc comment in
  `admin/routes.ts` described the OLD, superseded "not-linked means no key pasted" semantics —
  stale relative to the self-derivation fix above.** CONFIRMED by the validator, but the underlying
  BEHAVIOR was found to be correct and deliberate (not a bug) — only the doc comment (and, less
  centrally, `design.md`'s original Approach section) never caught up to the fix. Validator
  explicitly recommended a documentation-only correction, not a behavior change (re-gating status on
  the paste would misrepresent the vault's real state and risk reintroducing the exact regression the
  fix resolved). **Fix:** rewrote the `SelfConnectorHalfView` doc comment in `admin/routes.ts` to
  describe the real, self-deriving semantics (`"not-linked"` = generated but `tick()` hasn't run yet,
  not "no key pasted"), with an explicit note on why `dualLinkKey` can legitimately be `null` while
  `standard`/`smart` read `"pending"`/`"active"`. Also added a "Post-build correction" addendum to
  `design.md` itself, so the design doc's historical Approach section stays intact but a reader isn't
  misled by its now-superseded `"not-linked"` framing.
- **[MEDIUM] (correctness) admin.js's live countdown could show "expired" for a secret the server
  had already silently refreshed.** The only periodic timer re-rendered the CACHED status object
  every second (a pure display tick, no network call) — an admin tab left open past the cached
  `expiresAt` with no navigation away-and-back would show a stale/misleading "expired" state even
  though `SelfConnectorLoop`'s own server-side interval (default 3h, well inside the 6h/24h TTLs)
  had already refreshed the real secret. CONFIRMED (traced `loadSelfConnector`'s single-fetch-then-
  local-tick shape directly). **Fix:** `loadSelfConnector()` now also self-schedules a 60s re-fetch
  poll that self-cancels once the Self Connector view is navigated away from — mirrors the existing
  `loadPythFlush()`/`pythFlushTimer` polling convention in the same file exactly (same visibility-
  check-then-clear shape), rather than inventing a new pattern.
- **[LOW] (correctness) `SelfConnectorLoop.tick()`'s lazy `DualLinkConnector` construction wasn't
  error-isolated, unlike every other failure path in this class and its SDK dependency.** A throw
  from `splitDualLinkKey` (inside `DualLinkConnector`'s constructor) on a malformed self-derived key
  would become an unhandled promise rejection via `start()`'s `setInterval(() => { void this.tick();
  }, ...)` — the same failure class `DualLinkConnector.tickHalf`'s own double-guarded `onError`
  handling exists to prevent one layer down (see Topic 1's own review). CONFIRMED. **Fix:** wrapped
  the constructor call in a try/catch, logging and leaving `dualLinkConnector` null (so a later tick
  can retry) rather than crashing the loop.
- **[MEDIUM] (conventions) `packages/pythia-client/src/index.ts`'s new `APOLLO_ACCOUNT_LEN`/
  `DUAL_LINK_BAR` re-export regressed the file's own one-name-per-line convention for multi-name
  export blocks — the EXACT convention an earlier review round this session already caught and fixed
  once on this same file.** CONFIRMED. **Fix:** reformatted to one name per line, matching every
  sibling block.
- **[MEDIUM] (conventions) The new Link `<input>` used a CSS class (`.input`) that doesn't exist
  anywhere in `styles.css`, and skipped the established `.conn-field` label wrapper every other text
  input in this file uses.** Rendered completely unstyled next to a styled button. CONFIRMED
  (grepped `styles.css` for `.input` — zero matches; confirmed every sibling field uses `<label
  class="conn-field">`). **Fix:** wrapped the input in `<label class="conn-field">`, matching the
  established pattern exactly, and dropped the phantom class.
- **[LOW] (conventions) The Self Connector panel's descriptive copy ("Read-only status; the on-chain
  deploy/link stays a manual operator action elsewhere") went stale the moment this topic added a
  mutating Link control to the same panel.** CONFIRMED. **Fix:** rewrote the panel note to describe
  the actual Generate-then-Link flow.
- **[MEDIUM] (tests) The admin route's REAL-wiring describe block never exercised the actual
  mismatch-rejection path** — only a FAKE thrown error (against the T4 fake `selfConnector`) and the
  success path (a matching real key) had coverage; the real `try/catch` around a REAL
  `SelfApolloVault.setDualLinkKey()` throw — what production's `index.ts` actually calls — was
  unverified end to end. CONFIRMED. **Fix:** new test posts a well-formed key with a genuinely
  mismatched standard half (an independently-generated other vault's account), asserting the real
  400 + message + that `dualLinkKey` stays unset.
- **[MEDIUM] (tests) `index.ts`'s `isSelfAccount`/`link` composition-root wiring had ZERO test
  coverage anywhere, even indirectly** — `routes.test.ts`'s "REAL wiring" block only covers the admin
  self-connector routes, never `registerConnectorAuth`/`isSelfAccount`; `selfConnectorIntegration.
  test.ts` (the one whole-app-level integration test) never passed `isSelfAccount` at all. The exact
  closure differentiating the 24h/6h TTL in production was never actually invoked by any test.
  CONFIRMED. **Fix:** new test in `selfConnectorIntegration.test.ts` mirrors `index.ts`'s exact
  `isSelfAccount` closure shape against real accounts, with the pair pre-populated as already-active
  (so a real secret is issued to inspect) — confirms Pythia's own accounts get a tight-bound ~24h
  `expiresAt` and a sibling non-self account (verified through the same registered route) gets a
  tight-bound ~6h `expiresAt`, strictly shorter than the self case's.
- **[MEDIUM] (tests) `setDualLinkKey`'s mismatch-rejection test only covered the standard-half
  branch** — the smart-half branch and whether the thrown message actually NAMES the correct
  mismatched half were both unverified; a regression swapping the two throw branches would have
  passed the existing loose `/does not match/` regex either way. CONFIRMED. **Fix:** added a
  symmetric smart-half mismatch test, and tightened both tests' assertions to also check the message
  names the specific half ("standard"/"smart"), not just the generic phrase.
- **[LOW] (tests) The "half missing entirely" regression test only covered the smart-half-missing
  case** — `tick()`'s guard (`if (!standardAccount || !smartAccount) return;`) is symmetric, but only
  one side was exercised; a regression checking only `standardAccount` would still have passed.
  CONFIRMED. **Fix:** added the mirrored standard-half-missing case.
- **[LOW] (security) `maskSecret()`'s passthrough for inputs under 14 chars gives no signal that
  masking didn't happen.** Unreachable via any current call site (the only value ever passed is a
  `pk_eph_`-prefixed secret, always well over 14 chars) — but as a published, dependency-free SDK
  primitive other consumers will reuse (per this topic's own design rationale), a future integrator
  feeding it a shorter credential would see it rendered in full with no warning. **Not fixed**: this
  is the EXACT behavior T1's own plan.md explicitly specified ("for a string SHORTER than 14 chars
  returns the string unchanged"), already deliberately tested (`maskSecret.test.ts`'s boundary
  tests). Changing it now would contradict a decision already made and tested, for a case that
  doesn't occur anywhere in this topic's actual call sites. Left as designed; noted here for any
  future consumer to be aware of, per the security lens's own suggestion.
- **[LOW] (tests) `admin.js`'s pure helper functions (`formatCountdown`, `selfConnectorHalfView`)
  have no automated tests, despite being trivially unit-testable in isolation.** **Not fixed**: no
  test harness exists for `admin.js` anywhere in this repo (confirmed — it's a plain browser script,
  not an ES module import target vitest can reach without a structural change), and this was an
  explicit, accepted scope boundary in plan.md's T6 (matching the existing Self Connector panel's own
  precedent before this topic). Fixing it would require restructuring how `admin.js` is loaded, well
  beyond this topic's scope. Verified by hand instead: element-id cross-matching (both directions)
  and a Node syntax check, per plan.md's own specified verification approach for this file.
- **Correctness lens, remainder:** `index.ts`'s `selfConnectorStatus()`/`toHalfView()`/`link` closure
  confirmed to match `admin/routes.test.ts`'s already-tested "REAL wiring" reference shape field for
  field (T5's own report cited this as its correctness anchor, given index.ts has no dedicated test);
  `EphemeralKeyStore.issue()`'s TTL selection confirmed correct (no off-by-one/precedence bug);
  `SelfApolloVault.setDualLinkKey()`'s validation confirmed to genuinely reject every malformed/
  mismatched case with no bypass, now with symmetric test coverage (see above).
- **Security lens, remainder:** the raw ephemeral secret confirmed to never reach the browser at any
  point in this diff (only `maskSecret(half.secret)`'s masked form + `expiresAt` are ever placed on
  `SelfConnectorHalfView`); `POST /admin/self-connector/link` confirmed gated behind the same `gate`
  middleware and OIDC-presence check as every sibling admin route; `SelfApolloVault.setDualLinkKey()`
  confirmed unable to make Pythia sign for an account she doesn't hold, since `SelfConnectorLoop`
  never even reads the stored `dualLinkKey` for its own ticking (self-derives instead), so
  `createSigner()`'s account-match guard can never actually be reached with a mismatched account via
  this path; `isSelfAccount` confirmed unspoofable by an external caller, since it's only evaluated
  on an `apolloAccount` that has already passed a real Apollo signature check against its on-chain
  public key.
- **Conventions lens, remainder:** `maskSecret.ts`/`maskSecret.test.ts` confirmed to keep the
  package's zero-runtime-dependency premise intact; `admin/routes.ts`'s new route's try/catch
  confirmed genuinely necessary (traced to `setDualLinkKey`'s real throw, not an avoidable pattern);
  `selfConnectorLoop.ts`'s doc-comment density/style confirmed consistent with its SDK dependencies;
  `admin.js`'s Link button wiring confirmed structurally parallel to the existing Generate button's
  disable/error/finally shape; version/changelog/README conventions confirmed to follow
  `docs/RELEASING.md`'s exact format split, all four version-bearing files agreeing at `2.6.0`.

## Verification (after all fixes)

- `npx vitest run` (whole `packages/pythia-client` suite, after rebuild) → **96 passed (13 files)**.
- `npx vitest run apps/pythia/src/selfConnectorIntegration.test.ts apps/pythia/src/admin/routes.test.ts apps/pythia/src/automaton/selfApollo.test.ts apps/pythia/src/automaton/selfConnectorLoop.test.ts`
  → **46 passed (4 files)**.
- `npm test -w @ancientpantheon/pythia` (whole-repo suite) → **559 passed (79 files)**.
- `npm run typecheck -w @ancientpantheon/pythia` and `-w @ancientpantheon/pythia-client` → clean.
- `node --check apps/pythia/public/admin.js` → clean; every `admin.js`-referenced `id` confirmed
  present in `admin.html` and vice versa (re-checked after the `.conn-field` markup fix).
- `publish.yml`'s 3 documentation-parity greps dry-run locally against `2.6.0` — all **PASS**.

Rounds: 1 (terminal, full-scope, 4-lens pass, plus one adversarially-validated correctness finding
downgraded HIGH→MEDIUM with its fix scope narrowed accordingly by the validator's recommendation).
1 HIGH (validated, doc-only fix) + 2 MEDIUM (correctness) + 1 LOW (correctness) + 2 MEDIUM
(conventions) + 1 LOW (conventions) + 3 MEDIUM (tests) + 1 LOW (tests) fixed; 1 LOW (security) and 1
LOW (tests) deliberately left as-is with recorded justification (design-intentional and out-of-scope
respectively). Zero STYLISTIC findings raised. Terminal state: full suite green across both
workspaces, typecheck clean, zero unresolved CONFIRMED findings requiring a fix.
