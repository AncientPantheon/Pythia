import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureSodiumReady, parseMasterKey } from "./codex/vault.js";
import { SealedStore } from "./codex/sealedStore.js";
import { SelfApolloVault } from "./automaton/selfApollo.js";
import { SelfConnectorLoop } from "./automaton/selfConnectorLoop.js";
import { createInProcessFetch } from "./connectors/self/inProcessFetch.js";
import { registerConnectorAuth } from "./routes/connectorAuth.js";
import { AuthNonceStore } from "./connectors/auth/nonceStore.js";
import { EphemeralKeyStore } from "./connectors/auth/ephemeralKeyStore.js";
import { DualLinkCache } from "./connectors/auth/dualLinkCache.js";
import { PendingActivationTracker } from "./connectors/auth/pendingActivationTracker.js";
import { createDualLinkActivateResolver } from "./automaton/khronoton/dualLinkActivateResolver.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let dir: string;

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-self-connector-integration-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Composition-level integration test: no `index.ts` test file exists (it has
 * import-time side effects that make importing it directly impractical), so
 * this test manually wires the SAME real pieces `index.ts` wires — mirroring
 * `connectorIntegration.test.ts` (pythia-client) and
 * `dualLinkActivateResolver.test.ts`'s own integration test: real
 * collaborators throughout, faking only the network/chain boundary (here:
 * `readApolloPublicKey`/`readApolloCounterpart`, which in production read the
 * chain — the in-process transport itself, `createInProcessFetch`, is real).
 */
describe("Pythia self-connector — composition-level integration", () => {
  it("tick() drives both of Pythia's own self-proofs through the REAL connector-auth + pending-activation pairing with zero self-case branching, and the dual-link-activate resolver picks up the resulting pair", async () => {
    // Real sealed-vault-backed dual-Apollo identity, generated FIRST — the
    // readApolloPublicKey/readApolloCounterpart closures below need real
    // account values to answer correctly.
    const sealedStore = new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });
    const vault = new SelfApolloVault(sealedStore);
    const { standardAccount, smartAccount } = await vault.ensureGenerated();
    expect(standardAccount).not.toBeNull();
    expect(smartAccount).not.toBeNull();

    // Reads the matching half's real on-chain-shaped public key straight off
    // the vault's own sealed store (production reads this off-chain instead —
    // see `readApolloPublicKeyForAuth` in index.ts).
    function publicKeyFor(account: string): string {
      const entryName = account === standardAccount ? "self-apollo-standard" : "self-apollo-smart";
      const raw = sealedStore.get(entryName);
      if (!raw) throw new Error(`selfConnectorIntegration test: no sealed entry for ${account}`);
      return (JSON.parse(raw) as { publ: string }).publ;
    }

    const app = new Hono();
    const nonceStore = new AuthNonceStore();
    const ephemeralKeyStore = new EphemeralKeyStore();
    // Neither of Pythia's own accounts is an active on-chain DualLink yet —
    // the realistic starting state for a brand-new self-identity.
    const dualLinkCache = new DualLinkCache({ poll: async () => new Set<string>() });
    const pendingActivationTracker = new PendingActivationTracker();

    registerConnectorAuth(app, {
      nonceStore,
      ephemeralKeyStore,
      dualLinkCache,
      readApolloPublicKey: async (account) => publicKeyFor(account),
      // Simulates that both halves are already linked on-chain
      // (C_LinkDualApiKey already ran) but not yet active: each account's
      // on-chain counterpart is the OTHER of Pythia's own two self-accounts.
      readApolloCounterpart: async (account) =>
        account === standardAccount ? smartAccount : standardAccount,
      pendingActivation: pendingActivationTracker,
    });

    const selfConnectorLoop = new SelfConnectorLoop({
      baseUrl: "http://pythia.self",
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await selfConnectorLoop.tick();

    // `recordProof` is fired-and-forgotten by the verify route (by design —
    // see connectorAuth.ts) and connectorAuth.test.ts's own tests for that
    // same route also `vi.waitFor` rather than assume it has already settled
    // the instant the HTTP round trip's promise resolves.
    await vi.waitFor(() => {
      expect(pendingActivationTracker.beginActivation()).not.toBeNull();
    });

    const ready = pendingActivationTracker.beginActivation();
    expect(ready).not.toBeNull();
    const pairedAccounts = [ready!.pair.standard, ready!.pair.smart];
    expect(pairedAccounts).toContain(standardAccount);
    expect(pairedAccounts).toContain(smartAccount);

    // The generic Khronoton dual-link-activate resolver — already covered by
    // its own tests — picks up the SAME pair with no self-case branching
    // anywhere in connectorAuth.ts/pendingActivationTracker.ts. `settle()` is
    // deliberately out of scope: that's the generic on-chain-broadcast engine layer.
    const resolver = createDualLinkActivateResolver(pendingActivationTracker);
    const { plan, payload } = resolver.resolve();
    expect(plan.length).toBeGreaterThan(0);
    expect(Object.values(payload)).toEqual(
      expect.arrayContaining([standardAccount, smartAccount]),
    );
  });
});
