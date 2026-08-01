import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptStringV2 } from "@stoachain/stoa-core/crypto";
import type { IOuroAccount } from "@ancientpantheon/codex/ouronet";
import { PythiaConnectorValidationError, DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { buildChallengeMessage } from "../connectors/verify/canonicalMessage.js";
import { CodexStore } from "./codexStore.js";
import { SelfApolloVault } from "./selfApollo.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let dir: string;
const store = () => new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });
const codex = () => new CodexStore(store());

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-selfapollo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Builds real, independently-generated Standard + Smart Apollo accounts
 * (mirrors `codexApolloSigner.test.ts`'s own `seedRealAccount`
 * fixture-building approach — genuine keypairs via `Apollo.generateRandom()`,
 * encrypted via `encryptStringV2`, real `originMode`/`originCurve` fields
 * Codex needs to re-derive). Deliberately TWO independent `generateRandom()`
 * calls, never one call's two address forms off a single keypair — Pythia's
 * own standard + smart accounts are a genuinely unrelated pair, matching
 * `design.md`'s own accounts shape. Seeds `c`'s snapshot with only whichever
 * of `which` are requested (default: both) — a caller can request just one
 * half seeded while still getting BOTH accounts' addresses back, to build a
 * well-formed-but-not-codex-held half for the "missing half" tests.
 */
async function seedCodexWithHalves(
  c: CodexStore,
  which: readonly ("standard" | "smart")[] = ["standard", "smart"],
): Promise<{ standardAccount: string; smartAccount: string; standardPublicKey: string; smartPublicKey: string }> {
  const registry = await import("@ouronet/dalos-crypto/registry");
  const codexPassword = c.getOrCreateCodexPassword();

  const standardFull = registry.Apollo.generateRandom();
  const smartFull = registry.Apollo.generateRandom();

  const accounts: IOuroAccount[] = [];
  if (which.includes("standard")) {
    accounts.push({
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
    });
  }
  if (which.includes("smart")) {
    accounts.push({
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
    });
  }
  c.saveBackup(JSON.stringify({ ouroAccounts: accounts }));

  return {
    standardAccount: standardFull.standardAddress,
    smartAccount: smartFull.smartAddress,
    standardPublicKey: standardFull.keyPair.publ,
    smartPublicKey: smartFull.keyPair.publ,
  };
}

const seedCodexWithRealPair = (c: CodexStore) => seedCodexWithHalves(c, ["standard", "smart"]);

function keyFor(pair: { standardAccount: string; smartAccount: string }): string {
  return `${pair.standardAccount}${DUAL_LINK_BAR}${pair.smartAccount}`;
}

describe("SelfApolloVault — accessors", () => {
  it("standardAccount()/smartAccount()/dualLinkKey() are all null before any setDualLinkKey call", () => {
    const vault = new SelfApolloVault(store(), codex());
    expect(vault.standardAccount()).toBeNull();
    expect(vault.smartAccount()).toBeNull();
    expect(vault.dualLinkKey()).toBeNull();
  });

  it("after setDualLinkKey with both halves held by the codex, dualLinkKey()/standardAccount()/smartAccount() all return the expected derived values", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);

    vault.setDualLinkKey(keyFor(pair));

    expect(vault.dualLinkKey()).toBe(keyFor(pair));
    expect(vault.standardAccount()).toBe(pair.standardAccount);
    expect(vault.smartAccount()).toBe(pair.smartAccount);
  });
});

describe("SelfApolloVault — setDualLinkKey", () => {
  it("a malformed key (wrong length) still throws PythiaConnectorValidationError, unchanged from before this redesign", () => {
    const vault = new SelfApolloVault(store(), codex());
    expect(() => vault.setDualLinkKey("too-short")).toThrow(PythiaConnectorValidationError);
    expect(vault.dualLinkKey()).toBeNull();
  });

  it("a well-formed key whose standard half is NOT held by the codex throws mentioning 'not held by Pythia's own Codex' AND 'standard', and dualLinkKey() stays null", async () => {
    const c = codex();
    const pair = await seedCodexWithHalves(c, ["smart"]); // only the smart half is actually seeded
    const vault = new SelfApolloVault(store(), c);

    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/not held by Pythia's own Codex/);
    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/standard/);
    expect(vault.dualLinkKey()).toBeNull();
  });

  it("a well-formed key whose SMART half is NOT held by the codex throws mentioning 'not held by Pythia's own Codex' AND 'smart', and dualLinkKey() stays null", async () => {
    const c = codex();
    const pair = await seedCodexWithHalves(c, ["standard"]); // only the standard half is actually seeded
    const vault = new SelfApolloVault(store(), c);

    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/not held by Pythia's own Codex/);
    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/smart/);
    expect(vault.dualLinkKey()).toBeNull();
  });
});

describe("SelfApolloVault — createSigner", () => {
  it("signing before any setDualLinkKey call rejects with a message containing 'no dual-link-key set'", async () => {
    const vault = new SelfApolloVault(store(), codex());
    const signer = vault.createSigner("standard");
    await expect(
      signer.sign({ apolloAccount: "₱.whatever", nonce: "n", rp: "pythia.ancientholdings.eu" }),
    ).rejects.toThrow(/no dual-link-key set/);
  });

  it("after setDualLinkKey with a real, codex-held pair, the standard signer produces a signature that independently verifies via Apollo.verify against the seeded keypair — a REAL round trip, not a mock", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));

    const signer = vault.createSigner("standard");
    const { signature } = await signer.sign({
      apolloAccount: pair.standardAccount,
      nonce: "n",
      rp: "pythia.ancientholdings.eu",
    });
    expect(signature).toEqual(expect.any(String));

    const registry = await import("@ouronet/dalos-crypto/registry");
    const message = buildChallengeMessage({ apollo: pair.standardAccount, nonce: "n", rp: "pythia.ancientholdings.eu" });
    expect(registry.Apollo.verify?.(signature, message, pair.standardPublicKey)).toBe(true);
  });

  it("after setDualLinkKey with a real, codex-held pair, the smart signer produces a signature that independently verifies via Apollo.verify against the seeded keypair", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));

    const signer = vault.createSigner("smart");
    const { signature } = await signer.sign({
      apolloAccount: pair.smartAccount,
      nonce: "n2",
      rp: "pythia.ancientholdings.eu",
    });

    const registry = await import("@ouronet/dalos-crypto/registry");
    const message = buildChallengeMessage({ apollo: pair.smartAccount, nonce: "n2", rp: "pythia.ancientholdings.eu" });
    expect(registry.Apollo.verify?.(signature, message, pair.smartPublicKey)).toBe(true);
  });
});
