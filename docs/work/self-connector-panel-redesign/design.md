# self-connector-panel-redesign — Design

Follow-on refinement to `self-connector-codex-signing` (v2.7.2), triggered by live user feedback
after successfully linking Pythia's own dual-Apollo pair for the first time: (1) the panel's visual
presentation doesn't match this codebase's own established "framed card" language used everywhere
else (Update & Deploy, StoaChain Earnings), and (2) showing two independent ephemeral secrets (one
per Apollo half) is confusing — only one is ever actually used for gating.

## Problem

1. **Two displayed ephemeral secrets imply two independent credentials, when only one is ever used.**
   Each Apollo half independently proves ownership and gets its own server-issued secret (genuine
   redundancy — if one half's refresh fails transiently, the other still works). But
   `DualLinkConnector.status()` already computes a single deduped `secret`/`expiresAt` (standard
   preferred, smart fallback) — the only value that ever reaches `x-pythia-key` for a real gated
   request. `SelfConnectorLoop`/`SelfConnectorStatus` never surfaced that consolidated value; the
   admin panel only ever showed the raw per-half breakdown, so it looks like two independent
   credentials exist when consumers only ever see one.
2. **The panel's markup predates this session's UI conventions and looks visually inconsistent
   with the rest of the admin surface.** Update & Deploy and StoaChain Earnings both use a framed
   "card" pattern (`.deploy-card`, `.deploy-row`, `.earn-card`) — bordered, radiused, gradient-
   backed containers with sub-rows for grouped data. The Self Connector panel is flat: bare badges
   and monospace text with no visual grouping at all.
3. **No visual "time remaining" indicator exists anywhere in this codebase yet** — every prior
   countdown (this panel's own `formatCountdown`) is text-only. The user explicitly asked for a
   depleting timer bar alongside the single consolidated key.

## Approach

**Backend: expose one consolidated ephemeral-key view, keep per-half state for diagnostics.**
`SelfConnectorLoop.status()` gains a new top-level field reading `DualLinkConnector`'s own already-
computed dedup logic directly (`this.dualLinkConnector?.status()`'s top-level `secret`/`expiresAt`
— no new dedup logic invented, just surfaced): `{ standard: SelfConnectorHalfStatus; smart:
SelfConnectorHalfStatus; secret: string | null; expiresAt: number | null }`. `SelfConnectorHalfView`
(admin-facing) drops `maskedSecret`/`expiresAt` — a half's view becomes JUST `{ state: "not-linked"
| "pending" | "active" }` (no secret data at the per-half level anymore — nothing consumes it once
the top-level value exists). `SelfConnectorStatus` gains top-level `maskedSecret: string | null` /
`expiresAt: number | null` (masked server-side via the existing `maskSecret()`, matching the
established "never ship the raw secret" convention).

**Admin UI: restructure into the established framed-card language.** The Self Connector panel
becomes one `.deploy-card`-style outer container (reusing that exact class — same gradient/border/
radius/padding every other "big panel" already uses) holding, top to bottom: (1) a panel-note
(unchanged content), (2) two `.deploy-row`-style sub-cards, one per half, each showing its account
string + a state chip (reusing `.deploy-chip`'s pill styling, three variants: not-linked/pending/
active — new chip color variants added alongside the existing running/success/failed ones), (3) ONE
ephemeral-key card (new, `.ttl-card`) shown only when `maskedSecret` is non-null: the masked secret,
a NEW depleting timer bar (`.ttl-bar`/`.ttl-bar-fill`, a horizontal bar whose width shrinks from
100% to 0% over the secret's lifetime, updated every second alongside the existing text countdown —
first visual timer element in this codebase), and the existing text countdown alongside it, (4) the
paste-a-dual-link-key form (unchanged function, restyled to sit inside the same card).

**Final task: update `organs/06-pythia-client-wire-in.md` again** — correct its description of the
proven pattern's UI guidance from "per-half masked secret + countdown" to "one consolidated masked
secret + countdown (+ bar), read from `DualLinkConnector.status()`'s own top-level dedup — never
build a per-half display," since that's now been proven wrong once already (the exact confusion
that triggered this topic) and a future Mnemosyne-side implementation should be steered away from
repeating it.

## Alternatives considered

- **Keep showing both per-half secrets, just visually de-emphasize one** — rejected: the user's own
  framing ("I thought there was a single ephemeral key... perhaps we need to correct this") is a
  correctness question, not just a styling one. Showing two active-looking secrets when only one is
  ever consumed is actively misleading, not just unpolished.
- **Invent a NEW dedup rule in the admin layer instead of reusing `DualLinkConnector.status()`'s
  existing one** — rejected: `DualLinkConnector` already owns this exact logic (standard preferred,
  smart fallback), tested, and used for the real `x-pythia-key` gating path. A second, independent
  implementation in the admin layer risks silently diverging from what's actually gating requests.
- **A generic `<progress>` element for the timer bar** — considered; using a styled `<div>` with an
  inline `width` percentage instead, matching every other custom-styled element in this codebase
  (no native `<progress>`/`<meter>` used anywhere else in admin.html) for full visual control
  (color transitions as it depletes) and consistency with the existing hand-rolled component style.

## Acceptance criteria

- [ ] The admin panel displays exactly ONE ephemeral secret (masked, `first7...last7`) for the
      whole linked pair, not one per half.
- [ ] A depleting horizontal timer bar is shown alongside that single secret, visually shrinking
      from full to empty as it approaches expiry, updating at least once per second.
- [ ] Each half still shows its own state (not-linked/pending/active) as a distinct diagnostic
      chip, so a struggling half is still visible even though its secret no longer displays
      separately.
- [ ] The panel visually matches the established framed-card language (`.deploy-card`/`.deploy-row`
      pattern) used by Update & Deploy and StoaChain Earnings — not a new, one-off visual style.
- [ ] `organs/06-pythia-client-wire-in.md` describes the single-consolidated-secret UI pattern,
      correcting its prior per-half guidance.

## Out of scope

- Any change to the underlying connector-auth protocol, `DualLinkConnector`, or the ephemeral-secret
  issuance/TTL logic itself — this topic only changes what's DISPLAYED and how it's laid out.
- Redesigning any OTHER admin panel's visual style — only Self Connector is touched, though it now
  matches the pattern the others already use.
- A generalized "timer bar" component published for reuse elsewhere — built once, for this panel;
  extracting it as a shared component is a future concern if a second use case appears.
