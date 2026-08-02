# khronoton-keyresolver-delegation — Design

## Problem

Every Khronoton consumer hand-rolls its own `KeyResolver` (the seam that turns a public key into a
signing-ready keypair) instead of reusing Codex's one complete implementation. Pythia's
`apps/pythia/src/automaton/khronoton/keyResolver.ts` was copied from Mnemosyne's, and both re-derived
every HD-wallet **seed** account with the `koala` SLIP-10 path only, ignoring `seedType` — so a
`chainweaver`/`eckowallet` operator seed re-derived a different key and the resolver's own guard
refused to sign (the real, live gas-payer signing failure fixed as a v2.7.13 stopgap by hand-adding
seedType routing). The root problem isn't the missing branch — it's that signing derivation is
reimplemented per-consumer at all. Codex (which the automaton already embeds) OWNS the complete,
seedType-aware resolver; the Hub's monolithic Khronoton never had this bug because it signed through
Codex's full resolver. Mnemosyne carries the identical latent bug.

## Approach

**Delegate the `KeyResolver` seam to Codex's own headless resolver in every consumer; stop
reimplementing derivation.** Codex publishes exactly this — `createHeadlessCodexResolver(deps)` →
`{ getKeyPairByPublicKey, listCodexPubs }`, seedType-complete (it routes on `seedType` via the same
`KadenaWalletBuilder` it used to RECORD the key).

**Feasibility verdict (resolved during shaping — this is the load-bearing finding): a clean
delegation is BLOCKED on a small Codex enablement.** Confirmed against Pythia's actual install:
- `createHeadlessCodexResolver` is value-exported **only from Codex's MAIN entry**
  (`@ancientpantheon/codex`), **not** the headless `/ouronet` subpath. Pythia's automaton must not
  import the main (UI-bundling) entry server-side — it correctly uses `/ouronet`.
- The deps-binding helpers a caller must supply (`buildExtendedForeignSigningKey`, `buildCodexPubSet`,
  a seedType-aware `deriveStoaChainKeypair` ≈ `StoaChainWalletBuilder.createWalletPairFromMnemonic`)
  are not cleanly reachable: `@stoachain/stoa-core/wallet` and `/signing` are **not exported
  subpaths** in Pythia's install (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

So Pythia cannot today bind all of `HeadlessResolverDeps` from the server-safe surface it's allowed
to touch. The correct fix therefore starts in Codex: expose, **from the headless `/ouronet`
(server-safe) subpath**, a resolver a consumer can adopt without binding bespoke `@stoachain` crypto.

Alternatives considered:
- **Keep the v2.7.13 seedType-aware hand-roll** — rejected: it's the reimplementation-per-consumer
  anti-pattern that caused this (and the Mnemosyne duplicate); it will drift from Codex again.
- **Pythia binds `createHeadlessCodexResolver`'s deps itself** — rejected as infeasible/fragile:
  the factory + helpers live only on Codex's main UI entry, and the `@stoachain` wallet/signing
  primitives aren't reachable from Pythia; hand-binding `deriveStoaChainKeypair` would re-introduce
  the very per-consumer derivation we're removing.
- **Import Codex's main entry server-side in Pythia** — rejected: it's a UI-bundling entry; pulling
  it into the keyless automaton is fragile (bundle weight, potential DOM refs) and violates the
  `/ouronet`-only headless discipline Pythia already follows.

Chosen path: **a small Codex enablement (export a pre-bound headless Kadena `KeyResolver` from
`/ouronet`), then each consumer delegates to it.** The pre-bound variant is preferred over exporting
`createHeadlessCodexResolver` + all deps helpers, because it lets consumers bind *nothing* bespoke —
which is the whole point (no consumer touches derivation).

## Acceptance criteria

- [ ] Codex exposes, from its headless `/ouronet` subpath, a server-safe Kadena `KeyResolver` a
      consumer can construct from a codex snapshot + a password source, with NO consumer-supplied
      `@stoachain` crypto deps (a pre-bound factory), returning `{ getKeyPairByPublicKey, listCodexPubs }`.
- [ ] Pythia's `keyResolver.ts` `getKeyPairByPublicKey`/`listCodexPubs` are backed by that Codex
      resolver — no seed derivation (`kadenaMnemonicToSeed`/`kadenaGenKeypairFromSeed`/chainweaver
      primitives) remains in Pythia's own source.
- [ ] Signing still works for BOTH a `koala` and a `chainweaver`/`eckowallet` operator seed
      (the v2.7.13 tests keep passing, now proving Codex owns the derivation).
- [ ] The Kadena-only public-key filter (`isKadenaPublicKey`, 64-hex) is preserved: Apollo-curve
      accounts never appear in `listCodexPubs`/the signer picker, whatever Codex's resolver returns.
- [ ] `createPythiaSignerSource` (the Builder signer-picker `SignerSource`) still lists the same
      Kadena-only descriptors — whether kept in Pythia or also delegated is a plan-time call, but its
      behavior is unchanged.
- [ ] The keyless-invariant scan, typecheck, and full Pythia suite stay green.
- [ ] Mnemosyne's `lib/khronoton/keyResolver.ts` is handed the same delegation (its latent
      koala-only bug removed at the root, not by copying Pythia's stopgap).

## Out of scope

- Changing Codex's derivation itself (correct as-is) or how seeds are generated/recorded.
- The v2.7.13 stopgap is NOT reverted until the delegation lands and is verified — it stays as the
  working interim so signing is never left broken.
- Any change to `ChainRuntime`, the tick loop, resolvers, or non-signing Khronoton seams.

## Topics

1. `khronoton-codex-headless-resolver-export` — **Codex handoff (blocks the rest).** Codex exports a
   server-safe, pre-bound headless Kadena `KeyResolver` from `/ouronet`. Handoff written:
   `docs/HANDOFF-codex-headless-kadena-resolver.md`; the implementation lands in `constructors/Codex`.
2. `khronoton-keyresolver-delegation-pythia` — **DONE (v2.7.14).** Pythia's `keyResolver.ts` now
   delegates all derivation to Topic 1's `createHeadlessKadenaResolver` (`@ancientpantheon/codex@0.8.0`),
   preserving the Kadena-only filter + signer-picker seam; koala+chainweaver tests re-pointed to prove
   Codex owns derivation. See `review.md`.
3. `khronoton-keyresolver-delegation-mnemosyne` — **Mnemosyne handoff written:**
   `docs/HANDOFF-mnemosyne-keyresolver-delegation.md`. Mnemosyne adopts the same delegation, removing
   its identical latent koala-only bug. Ready to hand to the Mnemosyne agent.
