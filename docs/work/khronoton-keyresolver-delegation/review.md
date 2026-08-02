# khronoton-keyresolver-delegation — Review (Topic 2: Pythia delegation)

Scope: `apps/pythia/src/automaton/khronoton/keyResolver.ts` + `keyResolver.test.ts` +
`engine.test.ts` (one assertion). Built against `@ancientpantheon/codex@0.8.0` (Topic 1 — the Codex
agent's `createHeadlessKadenaResolver` from `/ouronet`, published + installed). Security-critical
signing path — reviewed correctness + adversarial.

## What shipped

`createPythiaKeyResolver` now **delegates all key derivation** to Codex's
`createHeadlessKadenaResolver({ loadSnapshot, getPassword })`. Pythia's bespoke `fromSeedAccount` and
every hd-wallet derivation import (`kadenaMnemonicToSeed`/`kadenaGenKeypairFromSeed`/the chainweaver
primitives) are **deleted** — verified `grep -c` = 0 derivation primitives remain. Two non-derivation
Pythia concerns are retained: the Kadena-only public-key filter (`isKadenaPublicKey`, 64-hex, so
Apollo-curve accounts never enter the Kadena signer list) and a thin ouro-account fallback (Codex's
resolver reads only `{ kadenaSeeds, pureKeypairs }`, so a Kadena-format `ouroAccount` is resolved by
a direct secret decrypt — no derivation). `createPythiaSignerSource` (the Builder signer-picker) is
unchanged — Codex's `KeyResolver` doesn't cover the descriptor seam.

## Findings (all resolved)

- **[correctness] The two `IKadenaKeypair` types are not identical.** Codex's
  (`@stoachain/stoa-core/signing`) has `seedType?: string` and `encryptedSecretKey?: unknown`;
  Khronoton's requires `seedType: string` and `encryptedSecretKey?: string`. Delegating the return
  raw is a type error (caught by typecheck). **Resolved:** explicit field map — `seedType ?? "koala"`
  (the plain-hex nacl lane, correct default for a pure/foreign keypair) and a narrow
  `encryptedSecretKey as string | undefined` cast (at runtime it IS the @kadena EncryptedString,
  which is a string).
- **[correctness] The ouro fallback must not swallow real failures.** It runs ONLY on Codex's
  `CodexKeyMissingError` (genuine not-held); a real decrypt/derivation error or Codex's own wrong-key
  refusal guard (a plain `Error`, not `CodexKeyMissingError`) propagates unchanged. Verified by the
  wrong-key test (Codex's guard message propagates) and the ouro test (fallback runs only when Codex
  reports not-found).
- **[test-coverage] Delegation changes error messages + return shapes** — three keyResolver tests +
  one engine test asserted the OLD hand-rolled messages/shapes. **Resolved:** re-pointed to Codex's
  actual behavior — the koala AND chainweaver seed tests now prove **Codex** re-derives both seed
  types correctly (the core acceptance criterion: Pythia owns no derivation yet a chainweaver seed
  still resolves); the Apollo-rejection + unknown-key tests assert Codex's `CodexKeyMissingError`;
  the wrong-key test asserts Codex's guard message.
- **Adversarial checks:** bare-key matching (Pythia passes `bareKey(pub)`, Codex's snapshot stores
  bare pubkeys — matches); `listCodexPubs` on an empty codex returns size 0 (engine test);
  "codex not initialized" still throws through the delegate's `loadSnapshot` thunk (engine test);
  no Apollo pub can leak (final `isKadenaPublicKey` filter on the union).

## Verification

- `npx vitest run keyResolver.test.ts` → 9 passed (koala + chainweaver via Codex, ouro fallback,
  Apollo rejection, Kadena-only filter, wrong-key guard).
- `keyless-invariant.test.ts` → 15 passed (the new `@ancientpantheon/codex/ouronet` value imports
  sit inside the `automaton/` exemption).
- `npm run typecheck` → clean. `npm test` (whole repo) → **576 passed (82 files)**. `npm run build`
  (incl. islands) → clean.

Rounds: 1 (terminal). All findings resolved; delegation complete (0 derivation in Pythia); interim
v2.7.13 stopgap superseded. Topic 3 (Mnemosyne) still pending — same delegation, handed off.
