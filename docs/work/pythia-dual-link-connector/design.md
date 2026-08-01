# pythia-dual-link-connector — Design

Follow-on to `docs/work/pythia-self-consumer/design.md` (shipped as v2.4.0-2.4.3). Shaped in
conversation with the user (2026-08-01), correcting an earlier misunderstanding of the activation
flow along the way — see the "Approach" section's flow description, which reflects the corrected
understanding, not the original (wrong) one.

## Problem

Every piece of the connector protocol needed to obtain a live, gated `x-pythia-key` already
shipped (v2.3.0's Topics 1-3, v2.4.0's self-consumer). But the actual **consumer-facing input
contract** was never nailed down or built: given an *already-active* on-chain dual-Apollo pair,
what does a consumer (Pythia's own admin panel first, then Mnemosyne) actually paste into a
settings field, and what happens from there?

Three concrete gaps, confirmed against the real code, not assumed:

1. **No published way to interpret the identifier a consumer would naturally have in hand.** The
   on-chain `PYTHIA|T|DualLinks` table key — `<standard-apollo>|<smart-apollo>`, 325 chars — is
   exactly what a consumer sees after linking. Splitting it into the two account strings a
   `PythiaConnector` needs already exists as code (`splitDualLinkKey`,
   `apps/pythia/src/connectors/auth/dualLinkCache.ts`), but it's private to the Pythia service,
   never published. A consumer has no sanctioned way to use this identifier at all today.
2. **No reusable orchestration for "drive two `PythiaConnector`s from one dual-link-key and report
   one unified, displayable status."** This exact logic exists once, as `SelfConnectorLoop`
   (`apps/pythia/src/automaton/selfConnectorLoop.ts`) — but it's private, tied to Pythia's own
   self-generated identity, and not reusable by any other consumer. A prior attempt at a different
   consumer (Mnemosyne) hand-rolling an equivalent from scratch went wrong in several independent,
   confirmed ways (wrong key type, a broken on-chain signer, self-generating a NEW identity instead
   of referencing an already-active one) — see `automatons/Mnemosyne/docs/work/
   pythia-connector-auth/review.md` for the full account. Centralizing this once, published, tested,
   is the direct fix for that failure mode repeating.
3. **Nothing surfaces the thing a human actually wants to see.** Once a connector is active, no UI
   anywhere — not Pythia's own, nothing published for others to build against — shows the live
   secret (masked) or its countdown to expiry, and the server always issues the same TTL regardless
   of who's asking, when Pythia's own long-lived internal use case and a normal external consumer's
   use case call for different lifetimes.

## Approach

**The corrected activation flow (settling this before any design decision below depends on it):**
a consumer deploys+activates both Apollo halves via Codex (out of scope here — Codex's job).
Linking is then either a raw `C_Link` call (result: linked, inactive) or, more directly, proving
ownership through Pythia's own existing **browser** Link-verify flow (`connectorVerify.ts`), which
uses `A_Link` to create-if-missing **and** activate in one step. Either way, **a consumer only ever
has a dual-link-key worth pasting in once it is already active** — there is no "pending" state to
design a UX around in the normal path (the connector mechanism still handles a 202/pending response
defensively — e.g. if a link is later deactivated — but that's not the expected steady state).

**Two topics, sequential:**

1. **`pythia-client-dual-link-sdk`** (shape first, this session) — promote `splitDualLinkKey` and a
   new reusable connector class into the published `@ancientpantheon/pythia-client` package. New
   package version.
2. **`self-connector-dual-link`** (shaped once topic 1 ships) — consumes topic 1's new SDK surface
   to: (a) add differentiated ephemeral-secret TTLs (Pythia's own identity vs. everyone else), (b)
   add a "paste a dual-link-key" input to Pythia's own admin panel alongside the existing
   "Generate," proving the exact mechanism Mnemosyne will later use, (c) show the masked live
   secret + countdown timer. Its final task writes the resulting pattern into
   `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` for the
   Mnemosyne agent to follow — no separate docs-only topic; it's one task once the pattern is
   actually proven, not before.

**Alternatives considered for the SDK primitive's shape:**
- **Only export `splitDualLinkKey`, leave orchestration to each consumer** — rejected: this is
  exactly what already exists (a private split function) and exactly what already went wrong once
  (each consumer re-deriving the "two connectors + one status" logic itself, badly). The whole
  point of this project is closing that gap, not re-opening it.
- **A single connector object presenting the pair as one thing (hiding the two-halves-two-calls
  reality)** — rejected: the underlying protocol is genuinely per-account (two independent
  challenge/verify round trips), and papering over that with a fake single-call abstraction would
  make debugging a stuck half harder, not easier. The chosen shape (two `PythiaConnector`s under
  one orchestrator, unified status) is honest about the real shape while still being one thing to
  construct and poll.

## Acceptance criteria

- [ ] `@ancientpantheon/pythia-client` exports a function that splits a 325-char dual-link-key into
      its two account strings, validated (wrong length / no separator / malformed halves all
      rejected with a clear error).
- [ ] `@ancientpantheon/pythia-client` exports a class that, given a dual-link-key + two signers,
      drives both halves' `ensureSecret()` on a schedule and reports one status object including
      whether the pair is active and, if so, the live secret + its expiry.
- [ ] Pythia's own ephemeral-secret TTL differs by identity: her own self-connector accounts get a
      materially longer lifetime than the default issued to any other verified account.
- [ ] Pythia's own admin panel accepts a pasted dual-link-key (independent of the existing
      "Generate" self-identity flow) and, once active, displays the masked secret
      (`first7...last7`) and a live countdown to its expiry.
- [ ] The pantheonic-architecture doc a Mnemosyne-side agent would read describes this exact,
      proven API and UX pattern — not a re-description of the earlier (wrong) onboarding-wizard
      idea.

## Out of scope

- Actually wiring Mnemosyne itself — a separate, later pass in the Mnemosyne repo, once this
  project's pattern is documented.
- The `pythia-cronoton-keyset` re-pointing (external, chain-governance, standing blocker on
  automated `A_Link` firing for arbitrary future consumers) — orthogonal to this project, which is
  scoped to "given an already-active pair, use it," not "how it became active."
- Any change to the existing browser Link-verify flow (`connectorVerify.ts`) itself.

## Topics

1. `pythia-client-dual-link-sdk` — publish `splitDualLinkKey` + a reusable dual-connector class in
   `@ancientpantheon/pythia-client`.
2. `self-connector-dual-link` — differentiated TTLs, the paste-in admin UI + secret/timer display in
   Pythia's own panel (consuming topic 1), and the resulting Pantheon doc update.
