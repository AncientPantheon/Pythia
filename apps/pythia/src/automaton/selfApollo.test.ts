import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { isStandardApollo, isSmartApollo } from "../routes/connectorVerify.js";
import { apolloVerify } from "../connectors/verify/apolloVerify.js";
import { buildChallengeMessage } from "../connectors/verify/canonicalMessage.js";
import { SelfApolloVault } from "./selfApollo.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let dir: string;
const store = () => new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-selfapollo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SelfApolloVault — ensureGenerated", () => {
  it("is idempotent: a second call returns the same accounts and generates nothing new", async () => {
    const vault = new SelfApolloVault(store());
    const first = await vault.ensureGenerated();
    expect(first.standardAccount).not.toBeNull();
    expect(first.smartAccount).not.toBeNull();

    const registry = await import("@ouronet/dalos-crypto/registry");
    const spy = vi.spyOn(registry.Apollo, "generateRandom");

    const second = await vault.ensureGenerated();
    expect(second).toEqual(first);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("concurrent calls share ONE generation — never race to independently mint + overwrite a half's keypair (regression: HIGH concurrency-race fix)", async () => {
    // Two near-simultaneous calls (e.g. a double-click on the admin
    // "Generate" button, or two admin tabs) must never each observe
    // "not yet generated" and independently call Apollo.generateRandom(),
    // with the second silently clobbering the first's sealed entry — that
    // would orphan whichever account string the LOSING response displayed
    // (the one an admin might already be about to pay real on-chain STOA to
    // register).
    const vault = new SelfApolloVault(store());
    const registry = await import("@ouronet/dalos-crypto/registry");
    const spy = vi.spyOn(registry.Apollo, "generateRandom");

    const [a, b] = await Promise.all([
      vault.ensureGenerated(),
      vault.ensureGenerated(),
    ]);

    expect(a).toEqual(b);
    // Exactly one generation per half (standard + smart), not two.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("a failed in-flight generation does not wedge a later, separate attempt", async () => {
    const vault = new SelfApolloVault(store());
    const registry = await import("@ouronet/dalos-crypto/registry");
    const spy = vi
      .spyOn(registry.Apollo, "generateRandom")
      .mockImplementationOnce(() => {
        throw new Error("simulated generation failure");
      });

    await expect(vault.ensureGenerated()).rejects.toThrow(
      "simulated generation failure",
    );
    spy.mockRestore();

    const result = await vault.ensureGenerated();
    expect(result.standardAccount).not.toBeNull();
    expect(result.smartAccount).not.toBeNull();
  });

  it("produces a standardAccount recognized as ₱. and a smartAccount recognized as Π.", async () => {
    const vault = new SelfApolloVault(store());
    const { standardAccount, smartAccount } = await vault.ensureGenerated();
    expect(isStandardApollo(standardAccount!)).toBe(true);
    expect(isSmartApollo(smartAccount!)).toBe(true);
  });

  it("generates only the missing half when one already exists, leaving the existing half's sealed bytes untouched", async () => {
    const s = store();
    const seedVault = new SelfApolloVault(s);
    // Seed ONLY the standard half directly via a fresh vault, then discard its
    // smart entry so only "self-apollo-standard" exists on disk.
    await seedVault.ensureGenerated();
    s.delete("self-apollo-smart");
    expect(s.has("self-apollo-standard")).toBe(true);
    expect(s.has("self-apollo-smart")).toBe(false);

    const before = readFileSync(join(dir, "self-apollo-standard.sealed"));
    const standardAccountBefore = seedVault.standardAccount();

    const vault = new SelfApolloVault(s);
    const result = await vault.ensureGenerated();

    const after = readFileSync(join(dir, "self-apollo-standard.sealed"));
    expect(after).toEqual(before); // byte-identical — never re-sealed
    expect(result.standardAccount).toBe(standardAccountBefore);
    expect(result.smartAccount).not.toBeNull();
    expect(isSmartApollo(result.smartAccount!)).toBe(true);
  });
});

describe("SelfApolloVault — accessors", () => {
  it("standardAccount()/smartAccount() are null before generation", () => {
    const vault = new SelfApolloVault(store());
    expect(vault.standardAccount()).toBeNull();
    expect(vault.smartAccount()).toBeNull();
  });

  it("standardAccount()/smartAccount() read back the generated accounts", async () => {
    const vault = new SelfApolloVault(store());
    const { standardAccount, smartAccount } = await vault.ensureGenerated();
    expect(vault.standardAccount()).toBe(standardAccount);
    expect(vault.smartAccount()).toBe(smartAccount);
  });
});

describe("SelfApolloVault — createSigner", () => {
  it("a signature from the standard signer round-trips through the real apolloVerify", async () => {
    const vault = new SelfApolloVault(store());
    const { standardAccount } = await vault.ensureGenerated();
    const signer = vault.createSigner("standard");
    const { signature } = await signer.sign({
      apolloAccount: standardAccount!,
      nonce: "some-nonce",
      rp: "pythia.ancientholdings.eu",
    });

    const registry = await import("@ouronet/dalos-crypto/registry");
    const raw = JSON.parse(store().get("self-apollo-standard")!) as { publ: string };
    const message = buildChallengeMessage({
      apollo: standardAccount!,
      nonce: "some-nonce",
      rp: "pythia.ancientholdings.eu",
    });
    expect(registry.Apollo.verify?.(signature, message, raw.publ)).toBe(true);

    const ok = await apolloVerify(signature, message, raw.publ);
    expect(ok).toBe(true);
  });

  it("a signature from the smart signer round-trips through the real apolloVerify", async () => {
    const vault = new SelfApolloVault(store());
    const { smartAccount } = await vault.ensureGenerated();
    const signer = vault.createSigner("smart");
    const { signature } = await signer.sign({
      apolloAccount: smartAccount!,
      nonce: "another-nonce",
      rp: "pythia.ancientholdings.eu",
    });

    const raw = JSON.parse(store().get("self-apollo-smart")!) as { publ: string };
    const message = buildChallengeMessage({
      apollo: smartAccount!,
      nonce: "another-nonce",
      rp: "pythia.ancientholdings.eu",
    });
    const ok = await apolloVerify(signature, message, raw.publ);
    expect(ok).toBe(true);
  });

  it("a signer asked to sign for the OTHER half's account rejects up front (regression: LOW cross-check fix) — never silently signs a message that would fail to verify anyway", async () => {
    const vault = new SelfApolloVault(store());
    const { standardAccount, smartAccount } = await vault.ensureGenerated();
    const signer = vault.createSigner("standard");
    await expect(
      signer.sign({ apolloAccount: smartAccount!, nonce: "cross-nonce", rp: "pythia.ancientholdings.eu" }),
    ).rejects.toThrow(/asked to sign for .* but the "standard" half holds/);
    // Sanity: the SAME signer signing for its OWN account still works.
    await expect(
      signer.sign({ apolloAccount: standardAccount!, nonce: "cross-nonce", rp: "pythia.ancientholdings.eu" }),
    ).resolves.toEqual({ signature: expect.any(String) });
  });

  it("signing with a not-yet-generated half rejects with a clear, specific message instead of signing garbage", async () => {
    const vault = new SelfApolloVault(store());
    const signer = vault.createSigner("standard");
    await expect(
      signer.sign({ apolloAccount: "₱.whatever", nonce: "n", rp: "pythia.ancientholdings.eu" }),
    ).rejects.toThrow(/the "standard" half has not been generated yet/);
  });
});
