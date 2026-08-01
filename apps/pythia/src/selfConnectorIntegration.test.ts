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
import { SELF_EPHEMERAL_SECRET_TTL_MS, DEFAULT_EPHEMERAL_SECRET_TTL_MS } from "./connectors/auth/ephemeralKeyStore.js";

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

  it("wires isSelfAccount exactly as index.ts does — a verified request for one of Pythia's OWN accounts gets the 24h self TTL, a verified request for any other account gets the 6h default", async () => {
    // No test anywhere else actually drives index.ts's real isSelfAccount
    // closure (`account === selfApolloVault.standardAccount() || account ===
    // selfApolloVault.smartAccount()`) — routes.test.ts's "REAL wiring" block
    // only covers the admin self-connector routes, never
    // registerConnectorAuth/isSelfAccount. This test mirrors that exact
    // closure shape against real accounts, and — unlike the earlier test in
    // this file — pre-populates the dual-link cache as ALREADY ACTIVE, so a
    // real secret (with a real expiresAt) is actually issued to inspect.
    const sealedStore = new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });
    const vault = new SelfApolloVault(sealedStore);
    const { standardAccount, smartAccount } = await vault.ensureGenerated();

    function publicKeyFor(account: string): string {
      const entryName = account === standardAccount ? "self-apollo-standard" : "self-apollo-smart";
      const raw = sealedStore.get(entryName);
      if (!raw) throw new Error(`selfConnectorIntegration test: no sealed entry for ${account}`);
      return (JSON.parse(raw) as { publ: string }).publ;
    }

    const OTHER_ACCOUNT = "₱." + "z".repeat(160); // any account that is NOT Pythia's own
    const app = new Hono();
    const nonceStore = new AuthNonceStore();
    const ephemeralKeyStore = new EphemeralKeyStore();
    // Both of Pythia's own accounts AND the unrelated other account are
    // already active on-chain — isolates this test to the TTL-selection
    // question alone, independent of the activation-pairing flow the sibling
    // test above already covers.
    const dualLinkCache = new DualLinkCache({
      poll: async () => new Set([standardAccount!, smartAccount!, OTHER_ACCOUNT]),
    });
    await dualLinkCache.refreshNow();

    // OTHER_ACCOUNT has no real keypair of its own in this test — it's
    // signed further down using Pythia's OWN standard private key (purely to
    // produce a real, verifiable signature without standing up unrelated
    // crypto), so its "on-chain public key" must resolve to the MATCHING
    // public half of whatever key actually signs for it, or apolloVerify
    // would correctly reject the signature.
    function publicKeyForTestAccount(account: string): string {
      return account === OTHER_ACCOUNT ? publicKeyFor(standardAccount!) : publicKeyFor(account);
    }

    registerConnectorAuth(app, {
      nonceStore,
      ephemeralKeyStore,
      dualLinkCache,
      readApolloPublicKey: async (account) => publicKeyForTestAccount(account),
      // The EXACT closure shape index.ts wires — see index.ts's
      // registerConnectorAuth(...) call.
      isSelfAccount: (account) => account === standardAccount || account === smartAccount,
    });

    const selfConnectorLoop = new SelfConnectorLoop({
      baseUrl: "http://pythia.self",
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    const before = Date.now();
    await selfConnectorLoop.tick();
    const after = Date.now();
    const status = selfConnectorLoop.status();
    expect(status.standard.status).toBe("active");
    expect(status.smart.status).toBe("active");
    const selfExpiresAt = (status.standard as { expiresAt: number }).expiresAt;
    // Self accounts got the 24h TTL, not the 6h default — a tight bound
    // (matching connectorAuth.test.ts's own TTL assertions), not just
    // "greater than now" (which would pass for ANY positive TTL). The lower
    // bound anchors off `before` (captured before the real async round trip),
    // the upper bound off `after` (captured once it's done) — using a single
    // anchor for both would either be too loose (before - slack on both ends)
    // or flaky (before + TTL as the upper bound, with no slack for the real
    // wall-clock time `tick()`'s own network/signing work takes).
    expect(selfExpiresAt).toBeGreaterThan(before + SELF_EPHEMERAL_SECRET_TTL_MS - 5000);
    expect(selfExpiresAt).toBeLessThanOrEqual(after + SELF_EPHEMERAL_SECRET_TTL_MS);

    // A sibling, non-self account verified through the SAME registered
    // route gets the 6h default instead — apolloVerify isn't mocked in this
    // file (unlike connectorAuth.test.ts), so drive it through the real
    // headless challenge/verify HTTP round trip directly, signing with
    // Pythia's OWN standard key (apolloVerify only checks the signature
    // against the claimed account's on-chain public key, which this test's
    // readApolloPublicKey stub answers identically regardless of account).
    const registry = await import("@ouronet/dalos-crypto/registry");
    const { buildChallengeMessage, RP } = await import("./connectors/verify/canonicalMessage.js");
    const standardKeypair = JSON.parse(sealedStore.get("self-apollo-standard")!) as {
      priv: string;
      publ: string;
    };
    const challengeRes = await app.request("/connectors/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apolloAccount: OTHER_ACCOUNT }),
    });
    const { nonce } = (await challengeRes.json()) as { nonce: string };
    const message = buildChallengeMessage({ apollo: OTHER_ACCOUNT, nonce, rp: RP });
    // Mirrors selfApollo.ts's own guard on this optional primitive.
    if (typeof registry.Apollo.sign !== "function") {
      throw new Error("selfConnectorIntegration test: the Apollo primitive does not support signing");
    }
    const signature = registry.Apollo.sign(
      { priv: standardKeypair.priv, publ: standardKeypair.publ },
      message,
    );
    const beforeOther = Date.now();
    const verifyRes = await app.request("/connectors/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apolloAccount: OTHER_ACCOUNT, nonce, signature }),
    });
    const afterOther = Date.now();
    expect(verifyRes.status).toBe(200);
    const { expiresAt: otherExpiresAt } = (await verifyRes.json()) as { expiresAt: number };
    expect(otherExpiresAt).toBeGreaterThan(beforeOther + DEFAULT_EPHEMERAL_SECRET_TTL_MS - 5000);
    expect(otherExpiresAt).toBeLessThanOrEqual(afterOther + DEFAULT_EPHEMERAL_SECRET_TTL_MS);
    expect(otherExpiresAt).toBeLessThan(selfExpiresAt); // strictly shorter than the self TTL
  });
});
