# khronoton-seedtype-derivation — Design

Quick-scale bugfix (operator-reported: the Khronoton simulate failed with a signing error). Post-hoc
record.

## Problem

Once v2.7.12 surfaced the real simulate error in the UI, it read:
```
khronoton key resolver: seed "Pythia" derived a different key at index 0 than the codex recorded — refusing to sign.
```
The gas-payer key is stored in Pythia's operator Codex as an account under an HD-wallet **seed**
named "Pythia". To sign, `apps/pythia/src/automaton/khronoton/keyResolver.ts`'s `fromSeedAccount`
re-derives the keypair from the seed's mnemonic at the recorded account index and refuses to sign if
the derived public key ≠ the recorded one (a correct safety guard against signing with the wrong
key).

Root cause (confirmed cross-repo): Codex derives-and-records a seed account's public key with a
**seedType-aware** builder (`KadenaWalletBuilder.createWalletPairFromMnemonic`) —
`koala` (24-word BIP39) uses SLIP-10 Ed25519 (`m'/44'/626'/idx'`), while `chainweaver`/`eckowallet`
(12-word) use Chainweaver's BIP32-Ed25519 (WASM) scheme. Pythia's `fromSeedAccount` always used the
**koala path only**, ignoring `seedType`. The operator's "Pythia" seed is a chainweaver/eckowallet
seed, so Pythia re-derived a different key at index 0 → guaranteed mismatch → refused to sign.
Verified empirically: the same 12-word mnemonic yields different pubkeys under the koala vs
chainweaver derivations, and the chainweaver pubkey is password-independent (so a fresh transient
password reproduces exactly what Codex stored). Codex is NOT at fault — it records a pubkey it can
fully reproduce; Pythia's re-derivation was the half ignoring `seedType`.

## Approach

Make `fromSeedAccount` seedType-aware, matching Codex's derivation exactly:
- `koala`/default → unchanged (`kadenaMnemonicToSeed` + `kadenaGenKeypairFromSeed`).
- `chainweaver`/`eckowallet` → `kadenaMnemonicToRootKeypair` + `kadenaGenKeypair` from
  `@stoachain/kadena-stoic-legacy/hd-wallet/chainweaver`, returning the encrypted extended key as
  `encryptedSecretKey` + `password` (the WASM signing path), mirroring Codex's own headless resolver.

`KadenaWalletBuilder` itself couldn't be reused (`@stoachain/stoa-core/wallet` isn't an exported
subpath in Pythia's install), so the seedType switch is replicated with the underlying primitives —
which ARE available and are the exact ones Codex's builder calls. keyResolver.ts is inside the
`automaton/` keyless-invariant exemption, so the added `@stoachain/*` import is permitted.

## Acceptance criteria

- [x] A `chainweaver`/`eckowallet` seed account re-derives to its recorded pubkey and signs (no more
      "derived a different key" refusal) — `keyResolver.test.ts` seeds a real chainweaver seed and
      resolves it.
- [x] A `koala` seed account still re-derives + signs unchanged (regression test).
- [x] The safety guard still fires when a seed's recorded pubkey genuinely doesn't match its mnemonic
      (test with a deliberately mismatched pubkey).
- [x] keyless-invariant scan, typecheck, and full suite green.

## Out of scope

- Any change to how Codex generates/records seeds (correct as-is).
- The user could ALSO sidestep this with a non-seed Kadena key (a pure keypair or a Kadena-curve ouro
  account bypass re-derivation entirely) — but the proper fix makes their existing chainweaver seed
  work, so no user action is needed.
