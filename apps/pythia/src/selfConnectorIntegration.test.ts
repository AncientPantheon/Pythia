import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";
import { ensureSodiumReady, parseMasterKey } from "./codex/vault.js";
import { SealedStore } from "./codex/sealedStore.js";
import { CodexStore } from "./automaton/codexStore.js";
import { seedCodexWithRealPair } from "./automaton/codexApolloFixtures.js";
import { SelfApolloVault } from "./automaton/selfApollo.js";
import { SelfConnectorLoop } from "./automaton/selfConnectorLoop.js";
import { createInProcessFetch } from "./connectors/self/inProcessFetch.js";
import { registerConnectorAuth } from "./routes/connectorAuth.js";
import { AuthNonceStore } from "./connectors/auth/nonceStore.js";
import { EphemeralKeyStore } from "./connectors/auth/ephemeralKeyStore.js";
import { DualLinkCache } from "./connectors/auth/dualLinkCache.js";
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
 * `readApolloPublicKey`, which in production reads the chain — the
 * in-process transport itself, `createInProcessFetch`, is real).
 *
 * RETIREMENT NOTE (`self-connector-codex-signing`, T4): this file used to
 * also contain a test proving `SelfConnectorLoop` could drive both of
 * Pythia's OWN self-accounts through the REAL connector-auth +
 * `PendingActivationTracker` pairing flow BEFORE any `dualLinkKey` was ever
 * pasted — relying on `SelfApolloVault.ensureGenerated()` to discover the two
 * accounts on its own, independent of a paste. That capability is
 * deliberately retired by this topic
 * (`docs/work/self-connector-codex-signing/design.md`): Pythia no longer
 * generates or holds her own Apollo keypair locally at all — generation now
 * happens exclusively in Codex's own admin tab, and `SelfApolloVault`'s
 * `standardAccount()`/`smartAccount()` are derived PURELY from an explicitly
 * pasted `dualLinkKey()` (see `automaton/selfApollo.ts`). There is therefore
 * no account knowledge independent of a paste anymore, so
 * `SelfConnectorLoop.tick()` can no longer prove ownership of a not-yet-linked
 * pair for herself. This is a deliberate retirement, not a regression: the
 * user's actual workflow for Pythia's OWN identity is firing `A_Link`
 * manually, never relying on the auto-activation pipeline for herself.
 *
 * The GENERIC mechanism the retired test exercised (`PendingActivationTracker`,
 * `createDualLinkActivateResolver`, `connectorAuth.ts`'s activation-tracker
 * hook) remains fully intact and tested for real EXTERNAL consumers — nothing
 * about that shared capability is removed, only Pythia's own participation in
 * exercising it pre-link. See:
 *   - `apps/pythia/src/connectors/auth/pendingActivationTracker.test.ts`
 *   - `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.test.ts`
 *   - `apps/pythia/src/routes/connectorAuth.test.ts`'s own
 *     `"connector auth (activation-tracker hook)"` describe block
 */
describe("Pythia self-connector — composition-level integration", () => {
  // `seedCodexWithRealPair` is imported from `./automaton/codexApolloFixtures.js`
  // (see the top-of-file import) rather than defined locally here — that
  // file's own doc comment explains why: `encryptStringV2` may only be
  // imported from inside `automaton/`, per `keyless-invariant.test.ts`'s
  // directory-scoped (not filename-scoped) exemption for this specific check.

  /** The well-formed dual-link-key for a seeded pair's own two addresses,
   * joined via the SDK's own `DUAL_LINK_BAR` separator. */
  function keyFor(pair: { standardAccount: string; smartAccount: string }): string {
    return `${pair.standardAccount}${DUAL_LINK_BAR}${pair.smartAccount}`;
  }

  it("wires isSelfAccount exactly as index.ts does — a verified request for one of Pythia's OWN accounts gets the 24h self TTL, a verified request for any other account gets the 6h default", async () => {
    const sealedStore = new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });
    const codexStore = new CodexStore(sealedStore);
    const pair = await seedCodexWithRealPair(codexStore);
    const { standardAccount, smartAccount } = pair;
    const vault = new SelfApolloVault(sealedStore, codexStore);
    vault.setDualLinkKey(keyFor(pair));

    // Reads the matching half's real on-chain-shaped public key straight off
    // the seeded Codex snapshot (production reads this off-chain instead —
    // see `readApolloPublicKeyForAuth` in index.ts).
    function publicKeyFor(account: string): string {
      if (account === standardAccount) return pair.standardPublicKey;
      if (account === smartAccount) return pair.smartPublicKey;
      throw new Error(`selfConnectorIntegration test: no seeded public key for ${account}`);
    }

    const OTHER_ACCOUNT = "₱." + "z".repeat(160); // any account that is NOT Pythia's own
    const app = new Hono();
    const nonceStore = new AuthNonceStore();
    const ephemeralKeyStore = new EphemeralKeyStore();
    // Both of Pythia's own accounts AND the unrelated other account are
    // already active on-chain — isolates this test to the TTL-selection
    // question alone, independent of the activation-pairing flow the
    // retired sibling test used to cover (see this file's top-of-file
    // retirement note).
    const dualLinkCache = new DualLinkCache({
      poll: async () => new Set([standardAccount, smartAccount, OTHER_ACCOUNT]),
    });
    await dualLinkCache.refreshNow();

    // OTHER_ACCOUNT has no real keypair of its own in this test — it's
    // signed further down using Pythia's OWN standard private key (purely to
    // produce a real, verifiable signature without standing up unrelated
    // crypto), so its "on-chain public key" must resolve to the MATCHING
    // public half of whatever key actually signs for it, or apolloVerify
    // would correctly reject the signature.
    function publicKeyForTestAccount(account: string): string {
      return account === OTHER_ACCOUNT ? pair.standardPublicKey : publicKeyFor(account);
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
    const signature = registry.Apollo.sign(pair.standardKeyPair, message);
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
