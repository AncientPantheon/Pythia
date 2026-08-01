import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptStringV2 } from "@stoachain/stoa-core/crypto";
import type { IOuroAccount } from "@ancientpantheon/codex/ouronet";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { buildChallengeMessage } from "../connectors/verify/canonicalMessage.js";
import { CodexStore } from "./codexStore.js";
import { codexHoldsAccount, createCodexApolloSigner } from "./codexApolloSigner.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let dir: string;
const codex = () =>
  new CodexStore(new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) }));

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-codex-apollo-signer-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Builds one real `IOuroAccount`-shaped entry, encrypted under `codex`'s own
 * machine password — mirrors the Codex repo's own
 * `apollo-verify-auto-sign.test.ts` fixture-building approach so the round
 * trip through `autoSignApolloChallenge` is genuine, not mocked. */
async function seedRealAccount(
  c: CodexStore,
): Promise<{ account: IOuroAccount; publicKey: string }> {
  const registry = await import("@ouronet/dalos-crypto/registry");
  const full = registry.Apollo.generateRandom();
  const codexPassword = c.getOrCreateCodexPassword();
  const secret = await encryptStringV2(full.privateKey.bitString, codexPassword);
  const account: IOuroAccount = {
    id: "test-apollo-account",
    version: "1.0",
    isSmart: false,
    address: full.standardAddress,
    guard: null,
    stoaChainLedger: null,
    publicKey: full.keyPair.publ,
    secret,
    backup: "",
    originMode: "bitString",
    originCurve: "apollo",
  };
  c.saveBackup(JSON.stringify({ ouroAccounts: [account] }));
  return { account, publicKey: full.keyPair.publ };
}

describe("codexHoldsAccount", () => {
  it("returns false (never throws) when the codex has no snapshot yet", () => {
    const c = codex();
    expect(codexHoldsAccount(c, "₱.whatever")).toBe(false);
  });

  it("returns true for an account address present in the seeded snapshot, false for an unrelated one", async () => {
    const c = codex();
    const { account } = await seedRealAccount(c);

    expect(codexHoldsAccount(c, account.address)).toBe(true);
    expect(codexHoldsAccount(c, "₱.some-other-account")).toBe(false);
  });
});

describe("createCodexApolloSigner", () => {
  it("rejects with a message mentioning 'not initialized' before any snapshot is saved", async () => {
    const c = codex();
    const signer = createCodexApolloSigner(c, "₱.whatever");
    await expect(
      signer.sign({ apolloAccount: "₱.whatever", nonce: "n", rp: "r" }),
    ).rejects.toThrow(/not initialized/);
  });

  it("produces a signature that independently verifies via Apollo.verify against the seeded keypair — proves the round trip is real", async () => {
    const c = codex();
    const { account, publicKey } = await seedRealAccount(c);
    const signer = createCodexApolloSigner(c, account.address);

    const { signature } = await signer.sign({
      apolloAccount: account.address,
      nonce: "n1",
      rp: "pythia.ancientholdings.eu",
    });
    expect(signature).toEqual(expect.any(String));

    const registry = await import("@ouronet/dalos-crypto/registry");
    const message = buildChallengeMessage({
      apollo: account.address,
      nonce: "n1",
      rp: "pythia.ancientholdings.eu",
    });
    expect(registry.Apollo.verify?.(signature, message, publicKey)).toBe(true);
  });

  it("rejects with a message mentioning 'asked to sign for' when the sign() input account doesn't match the account this signer is scoped to", async () => {
    const c = codex();
    const { account } = await seedRealAccount(c);
    const signer = createCodexApolloSigner(c, account.address);

    await expect(
      signer.sign({ apolloAccount: "₱.different", nonce: "n", rp: "r" }),
    ).rejects.toThrow(/asked to sign for/);
  });

  it("propagates a rejection from autoSignApolloChallenge when the scoped account isn't in the codex's snapshot", async () => {
    const c = codex();
    await seedRealAccount(c); // codex has a snapshot, just not this account
    const signer = createCodexApolloSigner(c, "₱.not-in-snapshot");

    await expect(
      signer.sign({ apolloAccount: "₱.not-in-snapshot", nonce: "n", rp: "r" }),
    ).rejects.toThrow();
  });
});
