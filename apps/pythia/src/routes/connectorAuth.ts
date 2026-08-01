import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RP, buildChallengeMessage } from "../connectors/verify/canonicalMessage.js";
import { apolloVerify } from "../connectors/verify/apolloVerify.js";
import { isStandardApollo, isSmartApollo } from "./connectorVerify.js";
import { MAX_RELAY_BODY_BYTES } from "./relay.js";
import type { AuthNonceStore } from "../connectors/auth/nonceStore.js";
import {
  type EphemeralKeyStore,
  DEFAULT_EPHEMERAL_SECRET_TTL_MS,
  SELF_EPHEMERAL_SECRET_TTL_MS,
} from "../connectors/auth/ephemeralKeyStore.js";
import { APOLLO_ACCOUNT_LEN, type DualLinkCache } from "../connectors/auth/dualLinkCache.js";

/** ₱ = U+20B1 (Standard), Π = U+03A0 (Smart) — reuses connectorVerify.ts's
 * classifiers (not redefined), plus the fixed-length check the headless route
 * also requires (the browser-cookie flow doesn't enforce length since it only
 * ever handles chain-sourced accounts). */
function isValidApolloAccount(a: string): boolean {
  if (a.length !== APOLLO_ACCOUNT_LEN) return false;
  return isStandardApollo(a) || isSmartApollo(a);
}

const authBodyLimit = bodyLimit({
  maxSize: MAX_RELAY_BODY_BYTES,
  onError: (c: Context) => c.json({ error: "Request body too large" }, 413),
});

export interface ConnectorAuthDeps {
  nonceStore: AuthNonceStore;
  ephemeralKeyStore: EphemeralKeyStore;
  dualLinkCache: DualLinkCache;
  /** Reads the account's on-chain Apollo public key (the composition root
   * wires this to `readApolloPublicKey` against a chosen trust-anchor pair). */
  readApolloPublicKey: (apolloAccount: string) => Promise<string>;
  /** Optional — reads an Apollo account's on-chain `DualLink` counterpart
   * (the composition root wires this to `readApolloCounterpart` against a
   * trust-anchor pair). Only consulted for an account that isn't yet an
   * active dual link, to pair its just-proven ownership toward activation.
   * Both this and `pendingActivation` must be present for that pairing hook
   * to run at all — see `registerConnectorAuth`'s verify handler. */
  readApolloCounterpart?: (apolloAccount: string) => Promise<string | null>;
  /** Optional — an interface (not the concrete `PendingActivationTracker`)
   * so this route file doesn't pull in Topic 2's automaton-side
   * implementation; it only needs the one method it calls. */
  pendingActivation?: {
    recordProof(apolloAccount: string, counterpart: string): void;
  };
  /** Optional — identifies Pythia's own self-connector accounts, which get
   * the longer `SELF_EPHEMERAL_SECRET_TTL_MS` instead of the normal
   * `DEFAULT_EPHEMERAL_SECRET_TTL_MS` (see docs/work/self-connector-dual-link/
   * design.md — "differentiated TTLs"). The composition root wires this to a
   * closure comparing against `selfApolloVault.standardAccount()`/
   * `smartAccount()`. Omitted (or returning `false`) means the default TTL. */
  isSelfAccount?: (apolloAccount: string) => boolean;
}

/**
 * Headless challenge/verify HTTP routes for the connector-auth round trip
 * (see `docs/work/pythia-connector-protocol/design.md`). Parallel to — and
 * independent of — the existing browser-cookie Link-verify flow in
 * `connectorVerify.ts`: a headless caller (a consumer automaton's Codex) has
 * no browser session, so these routes carry no cookie and bind everything to
 * the apollo account directly via `AuthNonceStore`.
 *
 * Design choice: `apolloVerify` is imported and called directly here rather
 * than added to `ConnectorAuthDeps` as an injectable function. This mirrors
 * `registerConnectorVerify`'s existing convention (see `connectorVerify.ts`),
 * whose own tests already control both the success and failure verification
 * paths via `vi.mock("../connectors/verify/apolloVerify.js")` instead of a
 * route-level injection point — keeping the deps shape exactly as specified
 * (nonceStore/ephemeralKeyStore/dualLinkCache/readApolloPublicKey) and
 * consistent with the sibling route. `connectorAuth.test.ts` follows the same
 * pattern: a mocked `apolloVerify` returning true only for a sentinel
 * signature drives both the 401 "wrong signature" path and the 200 success
 * path deterministically, without needing real Apollo-curve signatures.
 */
export function registerConnectorAuth(app: Hono, deps: ConnectorAuthDeps): void {
  app.post("/connectors/auth/challenge", authBodyLimit, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { apolloAccount?: unknown } | null;
    const apolloAccount = typeof body?.apolloAccount === "string" ? body.apolloAccount : "";
    if (!isValidApolloAccount(apolloAccount)) {
      return c.json({ error: "invalid apollo account" }, 400);
    }
    const { nonce, expiresAt } = deps.nonceStore.issue(apolloAccount);
    return c.json({ nonce, rp: RP, expiresAt });
  });

  app.post("/connectors/auth/verify", authBodyLimit, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { apolloAccount?: unknown; nonce?: unknown; signature?: unknown }
      | null;
    const apolloAccount = typeof body?.apolloAccount === "string" ? body.apolloAccount : "";
    const nonce = typeof body?.nonce === "string" ? body.nonce : "";
    const signature = typeof body?.signature === "string" ? body.signature : "";

    if (!deps.nonceStore.consume(nonce, apolloAccount)) {
      return c.json({ error: "invalid or expired nonce" }, 400);
    }
    // Read the active-dual-link check ONCE, up front — it both gates the
    // route (as before, when Topic 2's tracker isn't wired in) AND, further
    // down, decides whether a successful verify should feed the activation
    // pairing hook. The gate itself only relaxes when BOTH new deps are
    // present: an account that isn't yet active can then still prove
    // ownership here (that proof is exactly what the tracker needs), but
    // with no tracker wired in the route's behavior is unchanged.
    const isActiveAccount = deps.dualLinkCache.isActiveAccount(apolloAccount);
    const canRecordActivationProof = Boolean(deps.readApolloCounterpart && deps.pendingActivation);
    if (!isActiveAccount && !canRecordActivationProof) {
      return c.json({ error: "not an active dual link" }, 403);
    }

    // The chain read + signature check can both throw (e.g. no read pair
    // available, or no on-chain key for this account) — catch here so a
    // transient failure returns a structured JSON error like every other
    // route in this app, instead of falling through to Hono's default
    // unstructured 500. The nonce is ALREADY consumed at this point (above),
    // by design — see connectorAuth.test.ts / the review note on this — so a
    // caught failure here still costs the caller a fresh /challenge, but at
    // least surfaces as a clear, retryable JSON error rather than a crash.
    let publicKey: string;
    let ok: boolean;
    try {
      publicKey = await deps.readApolloPublicKey(apolloAccount);
      const message = buildChallengeMessage({ apollo: apolloAccount, nonce, rp: RP });
      ok = await apolloVerify(signature, message, publicKey);
    } catch (err) {
      console.error(
        `pythia connector auth: verify failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: "verification temporarily unavailable" }, 502);
    }
    if (!ok) {
      return c.json({ error: "signature verification failed" }, 401);
    }

    // Ownership is now PROVEN (signature verified above) — but proof of
    // ownership is a different thing from being an active dual link, and
    // only an active dual link may ever receive a working ephemeral secret
    // (Topic 1's own acceptance criterion: "never silently issue a secret"
    // for a non-active account — CONFIRMED CRITICAL in review round 1 of
    // this topic, where this branch fell through to `ephemeralKeyStore.issue`
    // unconditionally). A not-yet-active account that reaches this point
    // (only possible when both Topic 2 deps are wired — see the gate above)
    // still gets its proof recorded toward activation, fire-and-forget, but
    // is turned away WITHOUT a secret.
    if (!isActiveAccount) {
      if (deps.readApolloCounterpart && deps.pendingActivation) {
        const readApolloCounterpart = deps.readApolloCounterpart;
        const pendingActivation = deps.pendingActivation;
        void (async () => {
          try {
            const counterpart = await readApolloCounterpart(apolloAccount);
            if (counterpart !== null) {
              pendingActivation.recordProof(apolloAccount, counterpart);
            }
          } catch (err) {
            console.error(
              `pythia connector auth: activation proof recording failed — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      }
      return c.json(
        { error: "ownership proven, but not yet an active dual link — no secret issued" },
        202,
      );
    }

    const ttlMs = deps.isSelfAccount?.(apolloAccount)
      ? SELF_EPHEMERAL_SECRET_TTL_MS
      : DEFAULT_EPHEMERAL_SECRET_TTL_MS;
    const { secret, expiresAt } = deps.ephemeralKeyStore.issue(apolloAccount, ttlMs);
    return c.json({ secret, expiresAt });
  });
}
