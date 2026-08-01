# self-connector-panel-redesign — Review

Scope: all 5 plan.md tasks — `apps/pythia/src/automaton/selfConnectorLoop.ts(+.test)` (T1),
`apps/pythia/src/admin/routes.ts(+.test)` (T2), `apps/pythia/src/index.ts` (T3),
`apps/pythia/public/admin.{html,js}` + `apps/pythia/public/styles.css` (T4), and
`websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` +
`docs/pantheonic-architecture/CHANGELOG.md` (T5). This topic consolidates the two per-half
ephemeral secrets Pythia's own admin UI displayed into the single value `DualLinkConnector.status()`
already computes and is the only one ever used for real `x-pythia-key` gating, and redesigns the
panel into the established `.deploy-card`/`.deploy-row`/`.deploy-chip` framed visual language plus a
new depleting timer bar. Correctness, security, conventions, and test-coverage lenses all ran.

## Round 1 — full-scope pass

- **Correctness lens: zero findings.** Traced `SelfConnectorLoop.status()`'s new top-level
  `secret`/`expiresAt` fields to confirm they're a pure pass-through of `DualLinkConnector.status()`'s
  own already-published dedup (no new logic invented); confirmed `halfStatus`'s refactor to take the
  already-fetched `dualLinkStatus` as a parameter means `DualLinkConnector.status()` is now called
  exactly once per `SelfConnectorLoop.status()` call (previously up to three); confirmed `index.ts`'s
  `toHalfView` no longer imports/calls `maskSecret` per half, and the top-level computation happens
  exactly once; confirmed `admin.js`'s `SELF_TTL_MS` clamp (`Math.max(0, Math.min(100, ...))`) can't
  produce an out-of-range bar width under clock drift or a stale cached status.
- **Security lens: zero findings.** Confirmed the consolidated `maskedSecret` is still computed
  server-side (never the raw secret shipped to the browser as a byproduct of the refactor); confirmed
  no new route or field widens what an authenticated `ancient` admin session can read beyond what was
  already exposed pre-redesign (strictly narrower, in fact — only one secret is ever shown now,
  instead of two); confirmed `admin.html`'s new markup introduces no new form field or endpoint.
- **[MEDIUM] (conventions) `<h3>Self Connector</h3>` sat outside `.deploy-card` with no `.deploy-h`
  class**, rendering with default browser UA heading styles instead of matching Update & Deploy's
  heading treatment — the one visual inconsistency in an otherwise faithful reuse of that card
  pattern. CONFIRMED (direct comparison against the Update & Deploy section's own heading markup).
  **Fix:** moved the heading inside `.deploy-card`, added `class="deploy-h"`.
- **[MEDIUM] (conventions) Account/secret/countdown spans used `.sec-fingerprint`** (an older class
  with no `font-family` override, inheriting the proportional body font) **instead of
  `.deploy-row-sub`** (the established monospace class this same file already uses for every other
  hash-like value inside a `.deploy-row`). CONFIRMED. **Fix:** changed all four spans
  (`#selfconn-standard-account`, `#selfconn-smart-account`, `#selfconn-secret`,
  `#selfconn-countdown`) to `class="deploy-row-sub"`.
- **[MEDIUM] (conventions) `.deploy-chip--not-linked` and `.deploy-chip--pending` were byte-for-byte
  identical rules** (both gold), collapsing two operationally different states — "needs admin input"
  vs. "waiting on-chain, nothing to do" — into one indistinguishable look. CONFIRMED. **Fix:** gave
  `--pending` this codebase's existing `--cyan` accent (`#58c9e8`, the same value already used by
  `.verb--get`), keeping `--not-linked` gold.
- **[LOW] (conventions) The two half-status rows were wrapped in `.deploy-group` > `.deploy-rows`**,
  but `.deploy-group` is established elsewhere (`verGroup()` in `admin.js`) as a `<ul>`/`<li>` list
  always paired with a `.deploy-group-title` heading — using it on bare `<div>`s with no title worked
  visually only by CSS-reset coincidence, dropping the wrapper's real semantic purpose. CONFIRMED.
  **Fix:** removed the `.deploy-group` wrapper, using `.deploy-rows` directly (no group title was
  needed here).
- **[HIGH] (test coverage, CONFIRMED) The `maskedSecret: loopStatus.secret ? maskSecret(loopStatus
  .secret) : null` ternary's truthy branch was never exercised by any test anywhere in the repo.**
  Every existing test in `admin/routes.test.ts`'s "REAL wiring" describe block registers only
  `registerAdmin` on its test app — no connector-auth routes — so any tick a `link()` call triggers
  necessarily 404s per half and status can never progress past `"pending"`. This is exactly the one
  line responsible for preventing Pythia's real `x-pythia-key` value from leaking into an admin
  session response; a regression here (e.g. `?? null` instead of `? ... : null`, or an inverted
  ternary condition) would have passed the full 558/558 suite untouched. **Fix:** added a new test in
  that same describe block that registers a REAL `registerConnectorAuth` alongside `registerAdmin` on
  the same app, with a `DualLinkCache` pre-seeded active for the seeded pair (via `refreshNow()`) and
  `readApolloPublicKey` resolving to the pair's real public keys — driving `SelfConnectorLoop.tick()`
  through a genuine Codex-backed challenge/verify/sign round trip all the way to `"active"`. Asserts
  `maskedSecret` equals `maskSecret(rawSecret)` (the raw secret read directly off the loop as an
  independent oracle, test-only visibility), is never equal to the raw secret itself, and that a
  subsequent `GET` echoes the identical masked value.
- **[LOW] (test coverage) The "after a successful tick" test's `expiresAt` assertion was
  tautological** — it captured `expectedExpiresAt` directly from `status.standard.expiresAt`, then
  compared `status.expiresAt` against that same captured value. Since `DualLinkConnector.status()`'s
  own implementation makes `.standard` a literal object reference to the standard half's own result,
  the two fields are identical by construction — the comment claimed to avoid exactly this pattern
  but didn't. CONFIRMED. **Fix:** replaced with a `beforeTick`/`afterTick`-bracketed window check
  against `buildStubApp`'s own known `Date.now() + 3h` formula — a genuinely independent
  verification — and corrected the comment to describe what's actually being proven (which half's
  secret won, via the fixed per-account string; that the timestamp is a real freshly-issued value,
  via the bracketing window).
- **Test coverage lens, remainder:** confirmed the new not-linked/pending-both-halves/smart-fallback
  tests in `selfConnectorLoop.test.ts` (T1) genuinely distinguish "standard preferred" from "some
  secret" by asserting against the per-account fixed stub string, not just presence; confirmed
  `admin.html`/`admin.js` id cross-matching (`node --check admin.js` clean, every referenced id has a
  matching element, the removed `selfconn-standard-secret`/`selfconn-smart-secret` ids appear in
  neither file).

## Verification (after all fixes)

- `npx vitest run apps/pythia/src/admin/routes.test.ts` → **17 passed (1 file)**, including the new
  real-signing/masked-secret test.
- `npm test -w @ancientpantheon/pythia` (whole-repo suite) → **559 passed (80 files)**.
- `npm run typecheck -w @ancientpantheon/pythia` → clean.
- `node --check apps/pythia/public/admin.js` → clean.
- Re-read `admin.html`/`admin.js`/`styles.css` final diffs in full to confirm well-formed markup and
  the fixes above landed as described.

Rounds: 1 (terminal, full-scope, 4-lens pass). 3 MEDIUM + 2 LOW (conventions/test-coverage) + 1 HIGH
(test-coverage) fixed. Zero correctness/security findings. Terminal state: full suite green,
typecheck clean, zero unresolved CONFIRMED findings.
