## Wave 1

- [x] T1: `SelfConnectorLoop.status()` gains a top-level consolidated secret — done when:
      `apps/pythia/src/automaton/selfConnectorLoop.ts`'s `status()` return type becomes `{ standard:
      SelfConnectorHalfStatus; smart: SelfConnectorHalfStatus; secret: string | null; expiresAt:
      number | null }`. The new fields read `this.dualLinkConnector?.status()`'s own top-level
      `secret`/`expiresAt` directly — `DualLinkConnector.status()` (already published,
      `packages/pythia-client/src/dualLinkConnector.ts`) already computes "standard preferred, smart
      fallback, both null if neither active" exactly, so this is a straight pass-through, not a new
      dedup implementation. When `this.dualLinkConnector` is `null` (nothing linked yet — see the
      field's own doc comment), both new fields are `null`.
      Tests (TDD, write first) in `apps/pythia/src/automaton/selfConnectorLoop.test.ts` (existing
      file — add new assertions to relevant existing tests rather than only new `it` blocks, since
      this is an additive field on an already-tested return shape):
      - The existing "status() reports not-linked for both halves for a fresh vault" test gains an
        assertion that `loop.status().secret` and `.expiresAt` are both `null`.
      - The existing "after a successful tick, both halves report active..." test gains assertions
        that `loop.status().secret` equals the STANDARD half's secret (`secret-for-${standardAccount}`,
        matching `DualLinkConnector`'s own documented standard-preference) and `.expiresAt` equals the
        standard half's `expiresAt` — compare against an INDEPENDENTLY known value (not
        `loop.status().standard.expiresAt`, which would be comparing the same object to itself,
        tautological — use the stub's own fixed/derivable expected value or capture it once and
        compare both fields against that single captured value, not against each other).
      - New test: standard fails (401), smart succeeds (mirror the existing "isolates a half's verify
        failure" test's stub setup) — `loop.status().secret` equals the SMART half's secret (fallback
        proven, not just "some secret").
      - New test: both halves pending (202) — `loop.status().secret` and `.expiresAt` are both `null`
        (mirror the existing pending-response stub pattern already used in this file).
      Run `npx vitest run apps/pythia/src/automaton/selfConnectorLoop.test.ts` and `npm run typecheck
      -w @ancientpantheon/pythia` — both clean.
  - files: `apps/pythia/src/automaton/selfConnectorLoop.ts`, `apps/pythia/src/automaton/selfConnectorLoop.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T2: `admin/routes.ts` — move the masked secret from per-half to top-level — done when:
      `SelfConnectorHalfView` (in `apps/pythia/src/admin/routes.ts`) drops `maskedSecret`/`expiresAt`
      entirely — becomes `export interface SelfConnectorHalfView { state: "not-linked" | "pending" |
      "active"; }`. `SelfConnectorStatus` gains two new top-level fields, siblings of the existing
      `standardAccount`/`smartAccount`/`dualLinkKey`/`standard`/`smart`: `maskedSecret: string |
      null; expiresAt: number | null;`. Update both interfaces' doc comments to describe the new
      shape and cite `docs/work/self-connector-panel-redesign/design.md` for why (only one secret is
      ever actually used for `x-pythia-key` gating, regardless of which half issued it — showing two
      implied two independent credentials existed, which was misleading). No route-handler code in
      this file changes (the routes themselves just pass through whatever `SelfConnectorAdminControls
      .status()`/`.link()` return — the actual COMPUTATION of the new fields is `index.ts`'s job,
      Wave 3) — this task is a type-shape change plus updating this file's OWN test fixtures/mocks to
      match.
      Tests (TDD, write first) in `apps/pythia/src/admin/routes.test.ts`:
      - Update the `FIXTURE` object (in the FAKE-`selfConnector` describe block) to the new shape:
        `standard`/`smart` become bare `{state: "..."}` objects (no `maskedSecret`/`expiresAt`), and
        add top-level `maskedSecret`/`expiresAt` fields to the fixture itself. The existing tests in
        that block (GET returns fixture, link returns fixture, 401s) continue to pass against the
        updated fixture shape unchanged in intent — no new tests needed there, just the fixture
        update.
      - The "REAL SelfApolloVault + SelfConnectorLoop wiring" describe block's `makeRealApp` helper's
        inline `status()` function (which mirrors what `index.ts` will do in Wave 3) needs updating to
        build the new shape: `toHalfView` simplifies to just `{state: half.status}` (drop the
        `maskedSecret`/`expiresAt` mapping entirely from the per-half helper), and the returned
        `SelfConnectorStatus` object gains `maskedSecret: loopStatus.secret ? maskSecret(loopStatus
        .secret) : null, expiresAt: loopStatus.expiresAt` (reading T1's new `SelfConnectorLoop.status()`
        fields, already available from Wave 1). Update this describe block's existing assertions
        (the "reports null accounts and not-linked halves..." test, the "link succeeds..." test, the
        "mismatch rejected..." test) to the new shape — none of them currently assert on a
        secret/expiresAt value (no tick has run in any of them, per this describe block's own
        established convention — see its file-level comment), so their assertions should still read
        `standard: {state: "not-linked"}` / `smart: {state: "not-linked"}` (simplified from the old
        `{state, maskedSecret: null, expiresAt: null}` shape) plus, where relevant, a NEW top-level
        assertion `expect(status.maskedSecret).toBeNull()` / `expect(status.expiresAt).toBeNull()`
        (since nothing has ticked, the top-level fields stay null too — this is a genuinely new
        assertion worth adding, not just a mechanical rename).
      Run `npx vitest run apps/pythia/src/admin/routes.test.ts` and `npm run typecheck -w
      @ancientpantheon/pythia` — both will show remaining errors ONLY in `apps/pythia/src/index.ts`
      (Wave 3's file, not yet updated) — confirm via `npm run typecheck -w @ancientpantheon/pythia
      2>&1 | grep -v "src/index.ts"` producing no output.
  - files: `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/routes.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T3: `apps/pythia/src/index.ts` — compute the new top-level fields — done when:
      `selfConnectorStatus()`'s `toHalfView` helper simplifies to `function toHalfView(half:
      SelfConnectorHalfStatus): SelfConnectorHalfView { return { state: half.status }; }` (drops the
      `maskSecret`/`expiresAt` branch entirely — no import of `maskSecret` needed at THIS call site
      anymore for the per-half mapping). The function's returned object gains, computed once from
      `selfConnectorLoop.status()`'s new `secret`/`expiresAt` (T1): `maskedSecret: loopStatus.secret
      ? maskSecret(loopStatus.secret) : null, expiresAt: loopStatus.expiresAt` — `maskSecret` (still
      imported from `@ancientpantheon/pythia-client`) is now called exactly once per status
      computation instead of up to twice (once per half), at the new top-level site.
      No dedicated test file for index.ts (unchanged caveat from every prior topic touching this
      file) — correctness rests on matching T2's already-tested `makeRealApp` reference shape in
      `routes.test.ts` exactly.
      Verification: `npm run typecheck -w @ancientpantheon/pythia` fully clean (zero errors anywhere
      — this is the last file with outstanding type errors after T2). `npm test -w
      @ancientpantheon/pythia` full suite green, paying particular attention to
      `selfConnectorIntegration.test.ts` and `admin/routes.test.ts` in the output (the former asserts
      TTL differentiation via `selfConnectorLoop.tick()`/`.status()` directly, not through `index.ts`,
      so it should be unaffected by this task — confirm it still passes unmodified).
  - files: `apps/pythia/src/index.ts`

- [x] T4: `apps/pythia/public/admin.html` + `admin.js` + `styles.css` — the framed-card redesign with
      a single consolidated ephemeral-key display and depleting timer bar — done when:
      **`admin.html`**: the `<section class="admin-view" data-view="self-connector" hidden>` block
      (currently a flat sequence of a panel-note, two `.sec-status` divs, and a `.conn-actions` Link
      form) is restructured into ONE outer `<div class="deploy-card">` (the exact class Update &
      Deploy uses, lines ~165-206 of this same file — read that section as the structural reference)
      containing, in order: (1) the existing panel-note `<p>` (content unchanged), (2) two new
      half-status rows, one per half, each `<div class="deploy-row">` containing the account address
      text (`<span id="selfconn-standard-account">`/`id="selfconn-smart-account"`, ids UNCHANGED from
      today) and a state chip (`<span id="selfconn-standard-badge" class="deploy-chip">…</span>`/
      `id="selfconn-smart-badge"`, ids unchanged, class changed from the old `.sec-badge` system to
      the `.deploy-chip` system), (3) a new ephemeral-key card, `<div class="ttl-card" id="selfconn-
      ttl-card" hidden>` (hidden by default, shown via JS when a secret exists) containing the masked
      secret text (`<span id="selfconn-secret">`, NEW id — no longer per-half), a timer-bar element
      (`<div class="ttl-bar"><div class="ttl-bar-fill" id="selfconn-ttl-fill"></div></div>`), and the
      existing text countdown (`<span id="selfconn-countdown">`, NEW id — replaces the old per-half
      `#selfconn-standard-secret`/`#selfconn-smart-secret` spans, which are REMOVED), (4) the existing
      paste-in Link form (`#selfconn-link-input`/`#selfconn-link-btn`/`#selfconn-link-error` — ids
      UNCHANGED, just moved inside the card, restyled to sit naturally within it — e.g. drop any now-
      redundant outer `.conn-actions` wrapper if `.deploy-card`'s own spacing makes it unnecessary, or
      keep it if visually needed; use judgement, this is a minor layout call not a functional one).
      **`admin.js`**: `renderSelfConnector(st)` rewritten for the new `SelfConnectorStatus` shape:
      reads `st.standard.state`/`st.smart.state` for the two chips (reuse the existing state→chip-
      variant mapping logic, currently in `selfConnectorHalfView`, adapted to return a `.deploy-chip`
      modifier class name instead of the old `.sec-badge` one — see the styles.css task below for the
      exact new class names to target); reads `st.maskedSecret`/`st.expiresAt` ONCE (not per half) to
      populate `#selfconn-secret`'s text, and shows/hides `#selfconn-ttl-card` via its `hidden`
      attribute based on whether `st.maskedSecret` is non-null. A new `const SELF_TTL_MS = 24 * 60 *
      60 * 1000;` module-level constant (documented with a comment explaining this hardcodes Pythia's
      own self-connector TTL specifically — v2.6.0's `SELF_EPHEMERAL_SECRET_TTL_MS` — and is safe only
      because this panel is exclusively used for Pythia's own identity, never a generic consumer's).
      The existing 1s countdown `setInterval` (already built, re-renders off `lastSelfConnectorStatus`)
      now ALSO updates `#selfconn-ttl-fill`'s inline `style.width`, computed as `` `${Math.max(0,
      Math.min(100, ((expiresAt - Date.now()) / SELF_TTL_MS) * 100))}%` `` (clamped to [0, 100] so a
      slightly-stale cached status, or clock drift, can never produce an invalid width) — skip this
      update entirely (leave the bar at whatever it last was, or don't touch it) when `expiresAt` is
      `null`. `wireSelfConnector()`'s Link-button wiring is otherwise UNCHANGED (same fetch/disable/
      error/finally shape as today — this task doesn't touch that logic, only what gets rendered
      after).
      **`styles.css`**: new additions (append near the existing `.deploy-*` block, `.deploy-card`
      itself needs NO changes — reused as-is): three new `.deploy-chip` modifier classes —
      `.deploy-chip--not-linked` (reuse `.deploy-chip--running`'s exact color/border/background
      values — same visual weight as an in-progress/attention state), `.deploy-chip--pending` (same
      as `--not-linked`, since both represent "not yet successful" — or introduce a genuinely distinct
      amber tone if `--running`'s gold reads too close to `--active`'s below; use judgement, but keep
      it visually DISTINCT from `--active`), `.deploy-chip--active` (reuse `.deploy-chip--success`'s
      exact green values). A new `.ttl-card` rule mirroring `.deploy-row`'s bordered/radiused/padded
      look (`background: rgba(255,255,255,.025); border: 1px solid var(--line); border-radius:
      11px; padding: 12px 14px;` — copy `.deploy-row`'s exact values for visual consistency, don't
      invent new ones) but as a `flex-direction: column` container (unlike `.deploy-row`'s row
      layout) since it stacks secret text + bar + countdown vertically. New `.ttl-bar` (`height: 10px;
      border-radius: 999px; overflow: hidden; background: #060912; border: 1px solid var(--line);
      margin: 8px 0;` — mirrors `.deploy-pacman`'s track styling at a shorter height, since this is a
      slim progress bar not a 24px animation lane) and `.ttl-bar-fill` (`height: 100%; background:
      var(--gold); transition: width 1s linear;` — a single consistent gold fill, no color-shift
      logic, matching design.md's explicit "don't over-scope beyond the design's actual acceptance
      criteria" note).
      Verification (no automated test harness exists for these three files, matching every prior
      topic's convention): `node --check apps/pythia/public/admin.js` clean. Grep both `admin.html`
      and `admin.js` to confirm every `admin.js`-referenced `id` (`selfconn-standard-account`,
      `selfconn-standard-badge`, `selfconn-smart-account`, `selfconn-smart-badge`, `selfconn-ttl-card`,
      `selfconn-secret`, `selfconn-ttl-fill`, `selfconn-countdown`, `selfconn-link-input`,
      `selfconn-link-btn`, `selfconn-link-error`) has a matching `id` in `admin.html`, and that the
      REMOVED old ids (`selfconn-standard-secret`, `selfconn-smart-secret`) no longer appear in EITHER
      file (grep both directions — this file pair's own most common real bug class, per every prior
      topic's review). Re-read the final `admin.html`/`admin.js`/`styles.css` diff and confirm the
      new markup is well-formed (balanced tags, no orphaned closing divs) and that
      `selfConnectorHalfView`'s old three-state badge-text mapping (`"Active"`/`"Pending"`/`"Not
      linked"`) is preserved as the chip's TEXT content even though its CSS class family changed.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`, `apps/pythia/public/styles.css`

## Wave 4 (depends on Wave 3)

- [x] T5: Update the Pantheon architecture handoff doc — done when:
      `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` (repo root
      `/home/ancientbox/ClaudeWS/AncientPantheon/websites/Pantheon`)'s §2e (its UI-guidance paragraph,
      added in `self-connector-dual-link` and referenced again in `self-connector-codex-signing` —
      read the CURRENT file in full first, don't assume prior wording survived unchanged) is
      corrected: replace any "masked secret + countdown PER HALF" framing with the single-
      consolidated pattern — `DualLinkConnector.status()`'s own top-level `secret`/`expiresAt`
      (standard-preferred, smart-fallback) is the ONLY value a consumer's UI should ever display;
      per-half state remains useful to show separately (for diagnosing a struggling half), but a
      per-half SECRET display is explicitly called out as the wrong pattern this session already
      built once and had to correct, so a future implementation doesn't repeat it. Cite Pythia's own
      now-redesigned Self Connector panel (`apps/pythia/public/admin.{html,js}`, this topic) as the
      concrete reference. `docs/pantheonic-architecture/CHANGELOG.md` (same repo) gains a matching
      entry, following its existing format (check the two most recent entries — both from this same
      session's prior two topics touching this doc — for the exact convention).
      No automated test for documentation files. Verification: re-read the final diff and confirm it
      (a) doesn't contradict the rest of §2, (b) is technically accurate against the actual shipped
      code (cite real field names — `SelfConnectorStatus.maskedSecret`/`.expiresAt`, not invented
      ones), (c) is self-contained for a zero-context Mnemosyne-side agent. This task's own
      completion report states the exact filename (`organs/06-pythia-client-wire-in.md`) again, per
      the standing instruction to relay it to the user each time it's touched.
  - files: `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md`, `websites/Pantheon/docs/pantheonic-architecture/CHANGELOG.md`
