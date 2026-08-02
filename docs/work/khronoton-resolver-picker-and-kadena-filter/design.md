# khronoton-resolver-picker-and-kadena-filter — Design

Quick-scale fix (two independently-scoped bugs found while investigating the operator's "Pythia API
Link" cronoton setup question) — post-hoc record per this repo's `docs/work/` convention.

## Problem 1 — the Builder's "Server Resolver" dropdown had no options

Investigating how to wire up the "Pythia API Link" cronoton (the on-chain `A_LinkDualApiKey`
activation) surfaced that its server resolver — `dual-link-activate`
(`apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.ts`) — was already built, registered,
and tested (Topic 2, `connector-activation-resolver`, shipped earlier this session), but genuinely
**un-selectable** in the Khronoton admin UI: the Builder's "Server Resolver" dropdown is populated
from a `serverResolverOptions` prop on `<KhronotonProvider>` (khronoton-core's own design — not
auto-discovered from the server-side registry), and `apps/pythia/khronoton-ui/KhronotonApp.tsx`
never passed one. The dropdown showed only "None (ordinary cronoton)."

**Fix:** added `SERVER_RESOLVER_OPTIONS` (hardcoded literal `value` strings, not imported from the
server-side resolver modules — those pull in `@ancientpantheon/khronoton-core/server`'s Node-only
surface, which has no place in a browser-bundled island) listing both already-registered resolvers
(`pyth-flush`, `dual-link-activate`), passed via `serverResolverOptions` to `<KhronotonProvider>`.

## Problem 2 — the Kadena signing-key picker listed Apollo-curve keys

Reported live (screenshot): the "Ouronet Gas Station" cronoton's `DALOS.GAS_PAYER` signing-key
dropdown listed both valid 64-hex Kadena keys and clearly non-Kadena strings in Apollo's own
`<len>.<xy>` format (`9G.17Kd3B...`, `6g.5Bk81Dp...`). Traced to
`apps/pythia/src/automaton/khronoton/keyResolver.ts`: `createPythiaSignerSource`'s
`listSignerDescriptors()` (the picker's data source), `createPythiaKeyResolver`'s `listCodexPubs()`,
and its `getKeyPairByPublicKey()` all iterated Codex's `ouroAccounts` unconditionally, with no filter
on `IOuroAccount.originCurve` (`"dalos" | "apollo" | undefined`) — even though Codex's own type
already carries exactly the field needed to distinguish them. Neither Codex (which correctly exposes
`originCurve`) nor khronoton-core (deliberately chain-agnostic, its `CodexSignerDescriptor` carries
no curve concept at all) owns this — `keyResolver.ts` is Khronoton's Kadena-only signing seam in
Pythia and is the only layer that knows "this consumer only wants Kadena keys," but wasn't enforcing
it.

**Fix:** added `isKadenaOuro(acc)` (`acc.originCurve !== "apollo"` — undefined covers legacy entries
that predate the field, always Kadena) and applied it at all three `ouros(snap)` iteration sites,
including the actual signing path (`getKeyPairByPublicKey`), not just the picker — defense-in-depth
so an Apollo-curve key can never be selected OR (even if one somehow were) signed with as if it were
Kadena.

## Acceptance criteria

- [x] The Builder's "Server Resolver" dropdown offers both already-registered resolvers.
- [x] The Kadena signing-key picker excludes Apollo-curve `ouroAccounts` entries.
- [x] `getKeyPairByPublicKey()` rejects an Apollo-curve account's public key as "not held" rather
      than attempting to decrypt/return it as a Kadena keypair.
- [x] New test coverage: `apps/pythia/src/automaton/khronoton/keyResolver.test.ts` (previously had
      zero coverage) — 5 tests, reproducing the exact bug (fails pre-fix) before demonstrating the
      fix.
- [x] `npm run build` (islands) + full suite + typecheck all clean.

## The "Pythia API Link" cronoton — clarification, no code change needed

Investigating this also resolved the operator's actual question: `dual-link-activate` already exists
and already fires on Pythia's own 30-second Khronoton tick (`TICK_INTERVAL_MS`), polling
`PendingActivationTracker.beginActivation()` each tick and firing a genuinely empty/no-op tx when
nothing is ready — this is already, in effect, "event-triggered within ~30s," not a fixed daily/hourly
schedule like `A_Flush`. **No Khronoton engine change (an "evented transaction" primitive) is
needed** — the existing single-tx server-resolver + poll-for-readiness pattern already covers this
exact case, and is the same design `pythFlushResolver.ts` already uses successfully in production.
The only real gaps were the two bugs above (the un-selectable resolver, the polluted Kadena key
list), both fixed here. The correct Builder configuration for this cronoton (once deployed):

- **Pact code:** `(TS01-C4.PYTHIA|A_LinkDualApiKey (read-msg "standardApollo") (read-msg "smartApollo"))`
  — NOT `(read-string ...)` (that's the runtime-arg-trigger convention, a different Khronoton
  feature this cronoton doesn't use) and NOT the `A_Link`/`ouronet-ns.PYTHIA.TS01-C4...` shape from
  the pre-embedded-Khronoton hub-hosted design in `docs/HANDOFF-pythia-side-buildout.md` §9 (an
  earlier, now-superseded plan, predating Pythia's own Khronoton engine).
- **Server Resolver:** `dual-link-activate` (now selectable, see Problem 1's fix).
- **Externally fireable:** left OFF — this fires off Pythia's own tick, never an external caller.
- **Runtime Arg Keys:** left empty — the resolver supplies the payload, not a runtime-arg trigger.

No `docs/work/` design doc exists yet for "the second Khronoton transaction" the operator mentioned
wanting help with — its shape wasn't described in the request that prompted this fix.
