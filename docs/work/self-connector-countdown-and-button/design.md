# self-connector-countdown-and-button — Design

Quick-scale polish (two small, independently-scoped CSS/JS fixes reported live by the operator
against the just-shipped Self Connector account-zone layout) — post-hoc record per this repo's
`docs/work/` convention.

## Problem 1 — the countdown didn't visibly tick

`formatCountdown(ms)` dropped seconds whenever an hour or more remained (`"23h 59m"`), only
changing once a minute — the operator's own stated bar for trusting the panel is live ("when i see
the seconds ticking away, i know everything is in order") wasn't met.

**Fix:** always include seconds, at every magnitude (`"23h 58m 41s"` / `"42m 10s"` / `"17s"` /
`"expired"`). The existing 1s re-render interval (already built, `lastSelfConnectorStatus`-driven)
now visibly changes every second at any TTL remaining. `apps/pythia/public/admin.js`.

## Problem 2 — the Link button rendered squarish

`.conn-actions { display: flex; gap: .6rem }` has no `align-items`, so the flex default `stretch`
applied: the button (a plain `.btn`, short content) stretched to match its sibling `.conn-field`'s
full height (a label line + an input), which is taller than the button itself needs — squat and
blocky rather than a normal button shape.

**Fix:** `align-items: flex-end` on `.conn-actions` — lines the button up with the bottom of the
input instead of stretching across the label+input's combined height, the usual "label above,
button beside the input" form shape. Fixed at the shared rule, not a self-connector-only override —
`.conn-actions` backs several other admin forms (Add verifier, Add to Upload Pool, Add all) that
share the exact same field+button shape and would have the identical latent issue.
`apps/pythia/public/styles.css`.

## Acceptance criteria

- [x] The countdown text visibly changes every second regardless of how much TTL remains.
- [x] The Link button renders as a normal (non-square) button, aligned beside the input, not
      stretched to the label+input's combined height.
- [x] No test regressions (`admin.js`/`styles.css` have no automated test harness, per this repo's
      established convention for these files — verified via `node --check` + full suite).
- [x] Pantheonic architecture docs (`organs/06-pythia-client-wire-in.md`) updated to reflect the
      corrected `formatCountdown` behavior.

## Out of scope

- A copy-to-clipboard affordance for the account addresses (Codex's own UI has one) — not
  requested; the `title` attribute added in the prior topic already surfaces the full value on
  hover.
