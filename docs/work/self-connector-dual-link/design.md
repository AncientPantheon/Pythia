# self-connector-dual-link — Design

Topic 2 of `docs/work/pythia-dual-link-connector/design.md` (the approved umbrella project). Topic 1
(`pythia-client-dual-link-sdk`) shipped as v2.5.0: `@ancientpantheon/pythia-client` now exports
`splitDualLinkKey` and `DualLinkConnector`.

**Note on one architectural decision below:** the loop-unification question (evolve
`SelfConnectorLoop` to wrap the new `DualLinkConnector`, vs. run a second, separate instance
alongside it) was put to the user as an explicit choice with a recommended default. No response
arrived before this doc was written (matches this session's established away-time pattern), so the
recommended option — **evolve `SelfConnectorLoop`** — was taken, consistent with the standing
autonomous-build mandate for this session. Flagged here for review once the user is back; easy to
reverse if the alternative is preferred, since nothing outside `selfConnectorLoop.ts` depends on its
internals.

**Post-build correction (found and fixed during T5's build, adversarially validated CONFIRMED in
review):** the `"not-linked"` gating described below (§Approach, the `SelfConnectorHalfStatus`
snippet, and acceptance criterion 3) assumed `SelfConnectorLoop` would wait for a PASTED
`vault.dualLinkKey()` before ticking at all. Building it that way broke a real, already-shipped
capability: `apps/pythia/src/selfConnectorIntegration.test.ts` (from the earlier
`connector-activation-resolver` topic) proves ownership of a NOT-YET-linked pair by ticking
immediately after generation, to feed `PendingActivationTracker` — a flow that has no dual-link-key
to paste yet by definition. The shipped fix: `SelfConnectorLoop` self-derives its own key
(`standard + DUAL_LINK_BAR + smart`) from the vault's two known accounts the moment BOTH exist,
never waiting on a paste. `"not-linked"` now means "generated but `tick()` hasn't run yet," not "no
key pasted." `setDualLinkKey()`/the Link UI control still perform real, useful work (immediate
rejection of a key that doesn't match this vault's own accounts) — they're a confirmation/validation
action, not a functional prerequisite for the connector to work. See
`apps/pythia/src/automaton/selfConnectorLoop.ts`'s `dualLinkConnector` field doc comment for the
full rationale.

## Problem

Every piece needed to drive an already-active dual-Apollo pair now exists in the published SDK
(Topic 1), but three gaps stop Pythia's own panel from actually proving the mechanism end to end,
and from behaving sensibly once it does:

1. **Nothing lets an operator hand Pythia the dual-link-key her own generated pair gets once
   manually deployed + linked via Codex.** `SelfConnectorLoop` today drives two `PythiaConnector`s
   straight off `SelfApolloVault`'s held accounts — it never needs or accepts a dual-link-key at
   all, so it can never be used to validate the SAME generic mechanism (`DualLinkConnector` +
   pasted key) that Mnemosyne will later depend on. Per this session's own standing test plan, the
   user will manually activate ONE pair (Pythia's own) via chain authority they currently hold, then
   needs somewhere in Pythia's own UI to paste the resulting key and watch the mechanism work.
2. **One ephemeral-secret TTL fits none of the actual cases well.** `EPHEMERAL_SECRET_TTL_MS` is a
   flat 3h for every verified account, self or otherwise. Pythia's own long-lived internal identity
   warrants a materially longer lifetime (fewer unnecessary re-verifies); a normal external consumer
   should get a longer default than 3h too (per the user's explicit ask), just not as long as
   Pythia's own.
3. **Nothing shows a human the thing they actually want to see.** `SelfConnectorHalfStatus` already
   carries `secret`/`expiresAt` once active, but no UI anywhere reads them — the admin panel shows
   only a badge, never the masked secret or its countdown to expiry.

## Approach

**Server-side: differentiated TTLs.**
`ephemeralKeyStore.ts`'s `EPHEMERAL_SECRET_TTL_MS` (3h) splits into two named constants:
`DEFAULT_EPHEMERAL_SECRET_TTL_MS = 6h` (the new default for any verified account) and
`SELF_EPHEMERAL_SECRET_TTL_MS = 24h` (Pythia's own identity only). `EphemeralKeyStore.issue()`
gains an optional `ttlMs` parameter (defaulting to `DEFAULT_EPHEMERAL_SECRET_TTL_MS`, so every
existing caller is unaffected unless it opts in). `ConnectorAuthDeps` (`connectorAuth.ts`) gains an
optional `isSelfAccount?: (apolloAccount: string) => boolean`; the verify handler's existing
`deps.ephemeralKeyStore.issue(apolloAccount)` call becomes
`deps.ephemeralKeyStore.issue(apolloAccount, deps.isSelfAccount?.(apolloAccount) ?
SELF_EPHEMERAL_SECRET_TTL_MS : DEFAULT_EPHEMERAL_SECRET_TTL_MS)`. `index.ts` wires
`isSelfAccount` to a closure comparing against `selfApolloVault.standardAccount()`/
`smartAccount()`. No change to the existing `isActiveAccount` gate (already confirmed sufficient by
the user).

**`SelfApolloVault` gains dual-link-key custody.** A third sealed entry (`self-dual-link-key`,
alongside the existing `self-apollo-standard`/`self-apollo-smart`) holds the pasted key as plain
text — not sensitive key material, just the public composite account string, sealed anyway because
it already lives in the same vault and durability-across-restart matters. New methods:
`dualLinkKey(): string | null` (read), and `setDualLinkKey(key: string): void` — calls
`splitDualLinkKey` (Topic 1, `@ancientpantheon/pythia-client`) and throws (a clear, immediate error,
not a later silent tick failure) unless BOTH resulting halves exactly equal the vault's own held
`standardAccount()`/`smartAccount()`. This is the SELF panel — pasting a key for any pair other than
Pythia's own is always a mistake, and `createSigner()`'s existing account-match guard would only
catch it later, mid-tick, as a confusing `onError` firing instead of an immediate, actionable
rejection at paste time.

**`SelfConnectorLoop` evolves to wrap `DualLinkConnector`.** Same public shape
(`{baseUrl, fetchImpl, vault, intervalMs}` constructor, `tick()`/`start()`/`stop()`/`status()`), so
nothing outside this file changes its calling convention. Internally: once `vault.dualLinkKey()`
returns non-null, lazily constructs ONE `DualLinkConnector` (`dualLinkKey`, `standardSigner:
vault.createSigner("standard")`, `smartSigner: vault.createSigner("smart")`, `baseUrl`,
`fetchImpl`) and delegates `tick()`/`status()` to it; `start()`/`stop()` keep their own
`setInterval` (matching every other loop in this codebase) but only actually invoke `tick()`'s real
work once a connector exists — before that, a tick is a no-op, same as today's "account not
generated yet" skip. This retires the private duplicate per-half tick/error-isolation logic Topic 1
was built to generalize away, and means every future `PythiaConnector` fix (in-flight-refresh dedup,
typed error mapping, etc.) is inherited automatically instead of needing a second, hand-maintained
copy.

`SelfConnectorHalfStatus` gains a 4th state to keep "generated, no key yet" honestly distinct from
"key set, not yet active on-chain":

```ts
export type SelfConnectorHalfStatus =
  | { status: "not-generated" }               // no keypair yet
  | { status: "not-linked" }                   // keypair exists, no dual-link-key set yet
  | { status: "pending" }                       // dual-link-key set, not yet active on-chain
  | { status: "active"; secret: string; expiresAt: number };
```

**Admin surface.** `SelfConnectorAdminControls` (`admin/routes.ts`) gains `link(dualLinkKey:
string): Promise<SelfConnectorStatus>`, backing a new `POST /admin/self-connector/link` route
(`{dualLinkKey: string}` body; a validation failure from `setDualLinkKey` returns 400 with its
message, mirroring every other route's `{error: string}` shape). `SelfConnectorStatus`'s `standard`/
`smart` fields change from bare state strings to small view objects carrying what the UI needs to
render directly — masked secret and expiry, never the raw secret (mirrors the existing
`secretMask()` convention for the hub HMAC secret: mask server-side, never ship the raw value to the
browser for a value nothing has asked to reveal in full):

```ts
export interface SelfConnectorHalfView {
  state: "not-generated" | "not-linked" | "pending" | "active";
  maskedSecret: string | null;  // "pk_eph_a...xxxxxxx" shape, first7...last7 — only when active
  expiresAt: number | null;     // epoch ms — only when active
}
export interface SelfConnectorStatus {
  standardAccount: string | null;
  smartAccount: string | null;
  dualLinkKey: string | null;   // echoes what's currently set — not sensitive, just the account pair
  standard: SelfConnectorHalfView;
  smart: SelfConnectorHalfView;
}
```

**A tiny, published `maskSecret` helper.** Rather than Pythia's own admin.js and Mnemosyne's future
UI each writing their own `first7...last7` slicing (an easy place for an off-by-one or a
short-string edge case to diverge), `@ancientpantheon/pythia-client` gains one small, pure,
dependency-free export: `maskSecret(secret: string): string`. Another small, additive
`pythia-client` version bump — same "don't make every consumer re-derive an obvious primitive"
rationale as Topic 1, just much smaller in scope.

**UI.** The existing "Self Connector" `admin.html` section gains, alongside the current
Generate/badges: a "Link" text input + button for pasting a dual-link-key (posts to the new route,
renders its 400 error inline like every other admin form here); per-half masked secret + a live
countdown ("expires in 3h 58m", ticking client-side off the cached `expiresAt`, re-synced whenever
`loadSelfConnector()` re-polls) once `state === "active"`. No new panel/section — this stays inside
the existing Self Connector view, since it's the same identity, just a further-along state.

**Final task: the Pantheon doc.** `websites/Pantheon/docs/pantheonic-architecture/organs/
06-pythia-client-wire-in.md` gets a new section describing the now-PROVEN pattern: obtain an active
dual-link-key (via Codex deploy + either raw `C_Link` or Pythia's browser Link-verify flow),
construct a `DualLinkConnector` with per-half signers, wire `keyProvider()` into `PythiaClient`, and
(for any UI a consumer builds) use the published `maskSecret` + `status().expiresAt` for display —
exactly what Pythia's own panel now does. Filename reported to the user once this lands, so they can
point the Mnemosyne-side agent at it.

**Alternatives considered:**
- **Keep `SelfConnectorLoop` untouched, add a second parallel `DualLinkConnector` instance** —
  the lower-risk option put to the user; not chosen (see the note at the top) because it leaves two
  independent tick loops able to drive the SAME two accounts, and permanently keeps the exact
  duplicate logic Topic 1 exists to retire.
- **Send the raw ephemeral secret to the browser and mask client-side only** — rejected: the
  existing `secretMask()`/hub-HMAC-secret convention already establishes "mask server-side, no raw
  value over the wire for something nothing has asked to reveal in full" as this codebase's norm;
  breaking that norm here for no requested benefit (nobody asked for a reveal/copy action) would be
  a regression, not a simplification.
- **A brand-new admin panel section for the pasted-key flow, separate from "Self Connector"** —
  rejected: it's the same identity in a further-along state, not a different thing; splitting it
  would just make an operator hunt across two sections to understand one connector's status.

## Acceptance criteria

- [ ] A verified request from one of Pythia's own self-connector accounts receives a secret whose
      `expiresAt` is ~24h out; a verified request from any other active account receives one whose
      `expiresAt` is ~6h out (up from the prior flat 3h) — both independently observable via
      `connectorAuth.test.ts`.
- [ ] Pasting a dual-link-key into Pythia's own Self Connector panel that does NOT match her own
      held accounts is rejected immediately with a clear, specific error — no tick, no signer call.
- [ ] Pasting Pythia's own genuinely-matching dual-link-key causes her Self Connector panel to move
      from "not-linked" toward "active" once the pair is active on-chain, without any code change —
      driven entirely by the same `DualLinkConnector` class Topic 1 published.
- [ ] Once active, the panel displays each half's ephemeral secret masked as `first7...last7` and a
      live countdown to its expiry — never the raw secret.
- [ ] `organs/06-pythia-client-wire-in.md` describes this exact, proven pattern (dual-link-key in,
      `DualLinkConnector` + `maskSecret` out) for a Mnemosyne-side agent to follow.

## Out of scope

- Any change to the browser Link-verify flow (`connectorVerify.ts`) or the on-chain deploy/link
  transactions themselves — still entirely Codex's / the operator's job.
- A "reveal full secret" affordance — not requested; masked-only matches the existing
  hub-HMAC-secret convention and the user's literal ask.
- The `pythia-cronoton-keyset` re-pointing (external, chain-governance, standing blocker on
  autonomous `A_Link` firing for arbitrary future consumers) — orthogonal; this topic is about using
  an already-active pair, however it became active.
- Actually wiring Mnemosyne itself — a later, separate pass in the Mnemosyne repo.
