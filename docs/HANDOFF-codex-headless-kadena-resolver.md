# Handoff: Codex — export a server-safe, pre-bound headless Kadena `KeyResolver` from `/ouronet`

**To:** Codex agent (repo: `constructors/Codex`, package `@ancientpantheon/codex`).
**From:** Pythia agent, 2026-08-03.
**Why:** so Khronoton consumers (Pythia, Mnemosyne, …) can DELEGATE key resolution to Codex's own
complete, seedType-aware resolver instead of hand-rolling their own — which just caused a real live
signing bug and has a latent duplicate in Mnemosyne (see below). This is **Topic 1** of
`constructors/Pythia/docs/work/khronoton-keyresolver-delegation/design.md`; Pythia's and Mnemosyne's
delegation (Topics 2–3) are BLOCKED on this export.

## Background — the bug this prevents

Each Khronoton consumer injects a `KeyResolver` (`{ getKeyPairByPublicKey, listCodexPubs }`) into the
engine. Pythia (copying Mnemosyne) hand-rolled one that re-derived every HD-wallet **seed** account
with the `koala` SLIP-10 path only, ignoring `seedType`. A `chainweaver`/`eckowallet` operator seed
(12-word, Chainweaver BIP32-Ed25519 WASM scheme) therefore re-derived a DIFFERENT key at the same
index, and the resolver's own guard refused to sign (`seed "…" derived a different key at index N
than the codex recorded`). The Hub's monolithic Khronoton never hit this because it signed through
**Codex's own resolver**, which IS seedType-complete — it routes on `seedType` via
`KadenaWalletBuilder.createWalletPairFromMnemonic` (`@stoachain/stoa-core/dist/wallet/
KadenaWalletBuilder.js`), the same function Codex uses to RECORD the pubkey. The regression was
introduced when Khronoton became a package with a pluggable `KeyResolver` seam and consumers
reimplemented a subset. Pythia has a v2.7.13 seedType-aware STOPGAP; the real fix is delegation.

## What already exists in Codex (and the gap)

- `createHeadlessCodexResolver(deps: HeadlessResolverDeps): HeadlessCodexResolver` — the headless,
  seedType-complete resolver (`packages/codex-core/src/resolver/headlessResolver.ts`), returning
  `getKeyPairByPublicKey(snapshot, pub, password)` + `listCodexPubs(snapshot)`.
- `InternalCodexResolver` (`packages/codex-ouronet/src/resolver/InternalCodexResolver.ts`) — a
  turnkey `KeyResolver`, but it's the BROWSER variant: it takes a Zustand `CodexStore` and is
  unlock-gated (throws `CodexLockedError`). Not usable from a headless server automaton.

**The gap (confirmed against Pythia's installed `@ancientpantheon/codex`):**
1. `createHeadlessCodexResolver` is value-exported **only from the package's MAIN entry**
   (`@ancientpantheon/codex`), NOT from the headless `/ouronet` subpath. A keyless server automaton
   (Pythia's `automaton/` core) imports only `/ouronet` and must not pull in the main UI-bundling
   entry.
2. Even with the factory, a consumer must bind `HeadlessResolverDeps` (`deriveStoaChainKeypair` ≈
   `StoaChainWalletBuilder.createWalletPairFromMnemonic`, `buildExtendedForeignSigningKey`,
   `buildCodexPubSet`, `decryptSecret`, `decryptWalletSecret`, `toHex`) — but `@stoachain/stoa-core/
   wallet` and `@stoachain/stoa-core/signing` are **not exported subpaths** in a consumer's install
   (`ERR_PACKAGE_PATH_NOT_EXPORTED`), and the deps helpers aren't cleanly reachable. So a consumer
   cannot bind the seam from what it's allowed to touch.

## Requested change

Export, **from the headless `/ouronet` (server-safe, no-UI) subpath**, a **pre-bound** headless
Kadena `KeyResolver` a consumer can adopt binding **zero** `@stoachain` crypto itself. Suggested
shape (final API is your call — match Khronoton's `KeyResolver` contract from
`@stoachain/stoa-core/signing`, i.e. `{ getKeyPairByPublicKey(publicKey): Promise<IKadenaKeypair>;
listCodexPubs(): Promise<Set<string>> | Set<string> }`):

```ts
// from "@ancientpantheon/codex/ouronet"
export function createHeadlessKadenaResolver(opts: {
  /** Re-read fresh each call (fire-time), never cached — mirrors how Pythia's
   *  keyResolver/keyless automaton reads its sealed snapshot per fire. */
  loadSnapshot: () => SnapshotSlice | Promise<SnapshotSlice>;
  /** The codex machine password (server-held, auto-unlocked); read per call. */
  getPassword: () => string | Promise<string>;
}): KeyResolver;
```

- Internally binds ALL of `HeadlessResolverDeps` to the real `@stoachain` primitives (the
  seedType-aware `KadenaWalletBuilder.createWalletPairFromMnemonic`, `kadenaDecrypt`,
  `buildExtendedForeignSigningKey`, `buildCodexPubSet`, `smartDecrypt`, `toHexString`) — the
  consumer supplies none of them.
- `getKeyPairByPublicKey(pub)` / `listCodexPubs()` take the Khronoton-native no-arg-snapshot shape
  (the factory closes over `loadSnapshot`/`getPassword`), so it drops straight into the engine's
  `KeyResolver` seam.
- Server-safe: importing it from `/ouronet` must pull in NO React/DOM/UI code (the whole reason the
  main entry won't do).
- seedType-complete for koala / chainweaver / eckowallet, and keeps the wrong-key guard
  (a re-derived pubkey ≠ the recorded one must refuse to sign).

If a fully pre-bound factory is undesirable, the fallback is: re-export `createHeadlessCodexResolver`
+ a ready `defaultStoaChainHeadlessDeps` (all deps pre-bound) from `/ouronet`, so a consumer writes
`createHeadlessCodexResolver(defaultStoaChainHeadlessDeps)` and binds nothing. The pre-bound factory
is preferred (consumer binds nothing at all).

## Acceptance criteria

- [ ] A server-side consumer can `import { createHeadlessKadenaResolver } from
      "@ancientpantheon/codex/ouronet"` (or the deps-bound equivalent) and get a working
      `{ getKeyPairByPublicKey, listCodexPubs }` binding NO `@stoachain` crypto itself.
- [ ] Importing it from `/ouronet` loads no UI/React/DOM code (verifiable: a plain Node import
      succeeds headless).
- [ ] It resolves + signs correctly for `koala`, `chainweaver`, AND `eckowallet` seed accounts, plus
      `pure`/`ouro` accounts, and keeps the wrong-key refusal guard.
- [ ] Published (a normal Codex release); consumers auto-adopt via `@ancientpantheon/codex@latest` on
      deploy.

## Consumer note (what lands once this ships)

- **Pythia** (Topic 2): `apps/pythia/src/automaton/khronoton/keyResolver.ts` drops its bespoke
  derivation (the v2.7.13 seedType hand-roll) and delegates to this, keeping only its Kadena-only
  public-key filter (`isKadenaPublicKey`, 64-hex, so Apollo-curve accounts never enter the signer
  list) and its `SignerSource` builder-picker seam. The stopgap stays until this lands.
- **Mnemosyne** (Topic 3): `automatons/Mnemosyne/lib/khronoton/keyResolver.ts` has the identical
  latent koala-only bug and adopts the same delegation.
- Architecture principle recorded in
  `websites/Pantheon/docs/pantheonic-architecture/organs/05-khronoton-engine-wire-in.md` (the
  `KeyResolver` seam callout): delegate to Codex's headless resolver; don't hand-roll.
