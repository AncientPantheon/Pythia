import { encryptStringV2 } from "@stoachain/stoa-core/crypto";
import type { IOuroAccount } from "@ancientpantheon/codex/ouronet";
import type { CodexStore } from "./codexStore.js";

/**
 * Shared test-fixture helper: seeds `c`'s Codex snapshot with a REAL,
 * independently-generated Standard + Smart Apollo pair (genuine keypairs via
 * `Apollo.generateRandom()`, encrypted via `encryptStringV2`, with the
 * `originMode`/`originCurve` fields Codex's own `signApolloOwnership` needs
 * to re-derive — discovered the hard way during `codexApolloSigner.test.ts`'s
 * build: omitting them makes Codex default to `originMode: "seedWords"` and
 * fail re-derivation).
 *
 * Lives under `automaton/` — NOT because it signs anything itself, but
 * because `apps/pythia/tests/keyless-invariant.test.ts`'s "imports nothing
 * from @stoachain/* except the keyless dalos-crypto verify primitive" check
 * has NO `*.test.ts` filename exemption (unlike its sibling check a few
 * lines above it in that same file) — it exempts the `automaton/` directory
 * by NAME only. A test file OUTSIDE `automaton/` that imported
 * `encryptStringV2` directly (as `admin/routes.test.ts` and
 * `selfConnectorIntegration.test.ts` briefly did, self-connector-codex-
 * signing/T3+T4) trips that scan. Centralizing the one legitimate need for
 * this import here — inside the exempt directory — lets every consumer test
 * file import a plain function instead, with zero `@stoachain/*` exposure of
 * its own.
 *
 * Note for future readers: `codexApolloSigner.test.ts`, `selfApollo.test.ts`,
 * and `selfConnectorLoop.test.ts` (siblings in this same `automaton/`
 * directory, so none of them are BLOCKED from importing this file) each keep
 * their own local, near-identical copy of this fixture rather than importing
 * it from here — a deliberate choice from `self-connector-codex-signing`'s
 * plan (T2/T3/T4 were built in parallel, before this shared file existed,
 * and "duplicate rather than cross-import" was the explicit instruction to
 * keep those parallel tasks independent). This file exists specifically so
 * test files OUTSIDE `automaton/` (`admin/routes.test.ts`,
 * `selfConnectorIntegration.test.ts`) have a legal way to seed a realistic
 * Codex snapshot at all — it is not, despite appearances, "the" canonical
 * fixture every in-directory test is expected to consolidate onto. If any of
 * the four copies' `originMode`/`originCurve` fields ever need correcting
 * again, check all four.
 */
export async function seedCodexWithRealPair(c: CodexStore): Promise<{
  standardAccount: string;
  smartAccount: string;
  standardPublicKey: string;
  smartPublicKey: string;
  standardKeyPair: { priv: string; publ: string };
}> {
  const registry = await import("@ouronet/dalos-crypto/registry");
  const codexPassword = c.getOrCreateCodexPassword();

  const standardFull = registry.Apollo.generateRandom();
  const smartFull = registry.Apollo.generateRandom();

  const accounts: IOuroAccount[] = [
    {
      id: "test-self-standard",
      version: "1.0",
      isSmart: false,
      address: standardFull.standardAddress,
      guard: null,
      stoaChainLedger: null,
      publicKey: standardFull.keyPair.publ,
      secret: await encryptStringV2(standardFull.privateKey.bitString, codexPassword),
      backup: "",
      originMode: "bitString",
      originCurve: "apollo",
    },
    {
      id: "test-self-smart",
      version: "1.0",
      isSmart: true,
      address: smartFull.smartAddress,
      guard: null,
      stoaChainLedger: null,
      publicKey: smartFull.keyPair.publ,
      secret: await encryptStringV2(smartFull.privateKey.bitString, codexPassword),
      backup: "",
      originMode: "bitString",
      originCurve: "apollo",
    },
  ];
  c.saveBackup(JSON.stringify({ ouroAccounts: accounts }));

  return {
    standardAccount: standardFull.standardAddress,
    smartAccount: smartFull.smartAddress,
    standardPublicKey: standardFull.keyPair.publ,
    smartPublicKey: smartFull.keyPair.publ,
    standardKeyPair: standardFull.keyPair,
  };
}
