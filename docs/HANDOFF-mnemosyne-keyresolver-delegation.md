# Handoff: Mnemosyne — delegate the Khronoton `KeyResolver` to Codex (fix the latent seed-signing bug)

**To:** Mnemosyne agent (repo: `automatons/Mnemosyne`).
**From:** Pythia agent, 2026-08-03.
**Why:** Mnemosyne's hand-rolled Khronoton `KeyResolver` carries the **identical latent bug** Pythia
just fixed at the root — it re-derives every HD-wallet seed with the koala path only and will refuse
to sign a `chainweaver`/`eckowallet` operator seed. This is **Topic 3** of
`constructors/Pythia/docs/work/khronoton-keyresolver-delegation/design.md`.

## The bug (present in Mnemosyne now, just unhit)

`automatons/Mnemosyne/lib/khronoton/keyResolver.ts` (`fromSeedAccount`) re-derives EVERY seed with
`kadenaGenKeypairFromSeed` (koala SLIP-10 `m'/44'/626'/idx'`) and only branches on `seedType` for the
RETURN shape — never for the derivation. But Codex records a `chainweaver`/`eckowallet` seed's public
key with Chainweaver's BIP32-Ed25519 (WASM) scheme (12-word), which is a DIFFERENT key at the same
index. So the moment a Mnemosyne operator uses a chainweaver/eckowallet seed as a signer, the
resolver re-derives a different key and its own guard refuses to sign
(`seed "…" derived a different key at index N than the codex recorded`). Pythia hit this live with a
chainweaver gas-payer seed. Mnemosyne hasn't hit it only because no chainweaver seed has been used
there yet.

## The fix — delegate to Codex, don't reimplement derivation

Codex `0.8.0+` exports a server-safe, pre-bound headless Kadena `KeyResolver` from `/ouronet`:
```ts
import { createHeadlessKadenaResolver, CodexKeyMissingError } from "@ancientpantheon/codex/ouronet";
// or "@ancientpantheon/codex-ouronet" if that's how Mnemosyne imports codex

const delegate = createHeadlessKadenaResolver({
  loadSnapshot: () => /* Mnemosyne's decrypted codex snapshot slice: { kadenaSeeds, pureKeypairs } */,
  getPassword: () => /* the server-held machine password, read per call */,
});
// delegate is a KeyResolver: { getKeyPairByPublicKey(pub), listCodexPubs() }
```
It owns the ONE canonical, seedType-complete derivation (koala / chainweaver / eckowallet / pure) and
binds all `@stoachain` crypto itself — Mnemosyne binds none. Replace `fromSeedAccount` + the hd-wallet
derivation imports entirely with delegation to this.

**Mirror Pythia's reference implementation:** `constructors/Pythia/apps/pythia/src/automaton/
khronoton/keyResolver.ts` (v2.7.14). Points to carry over:
- Keep any Kadena-only public-key filter you have (so Apollo-curve accounts never enter the Kadena
  signer list) and your Builder signer-picker (`SignerSource`) — Codex's `KeyResolver` doesn't cover
  the descriptor seam.
- Codex's headless resolver reads only `{ kadenaSeeds, pureKeypairs }`, NOT `ouroAccounts`. If
  Mnemosyne's codex holds Kadena-format ouro accounts, keep a thin non-derivation fallback that runs
  ONLY on Codex's `CodexKeyMissingError` (direct secret decrypt, no derivation); any other error —
  including Codex's own wrong-key refusal guard — must propagate unchanged.
- The two `IKadenaKeypair` types differ: Codex's (`@stoachain/stoa-core/signing`) has `seedType?` and
  `encryptedSecretKey?: unknown`; Khronoton's requires `seedType` and `encryptedSecretKey?: string`.
  Map with `seedType ?? "koala"` + a narrow `encryptedSecretKey as string | undefined` cast.
- Re-point tests: seed a REAL koala AND a REAL chainweaver seed (generate via
  `@stoachain/kadena-stoic-legacy/hd-wallet` + `.../hd-wallet/chainweaver`), record the pubkey the
  seedType-correct way, and assert the resolver resolves both — proving Codex owns derivation. Keep a
  wrong-key test (Codex's guard message: "the codex derived a different public key … refusing to
  sign") and an unknown-key test (Codex's `CodexKeyMissingError`).

## Acceptance criteria

- [ ] `automatons/Mnemosyne/lib/khronoton/keyResolver.ts` delegates all derivation to
      `createHeadlessKadenaResolver`; no `fromSeedAccount`/hd-wallet derivation remains.
- [ ] Signing works for a `koala` AND a `chainweaver`/`eckowallet` seed (tests seed both).
- [ ] The wrong-key refusal guard still fires (via Codex); an unknown key is refused.
- [ ] Mnemosyne's typecheck + tests green; `@ancientpantheon/codex` pinned `>=0.8.0`.

Architecture principle: `websites/Pantheon/docs/pantheonic-architecture/organs/05-khronoton-engine-
wire-in.md` (the `KeyResolver` seam callout) — delegate to Codex's headless resolver, don't hand-roll.
