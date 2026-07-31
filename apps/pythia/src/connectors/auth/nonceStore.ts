import { randomBytes } from "node:crypto";
import { CHALLENGE_TTL_SECONDS } from "../verify/canonicalMessage.js";

/**
 * Headless, single-use, TTL'd nonce store for the connector auth challenge/verify
 * round trip (`/connectors/auth/challenge` + `/connectors/auth/verify`).
 *
 * Unlike `verify/store.ts`'s `VerifyStore`, this has no cookie/session concept —
 * headless callers (a consumer automaton's Codex) have no browser session, so a
 * nonce is bound directly to the apollo account it was issued for.
 */

interface NonceEntry {
  apolloAccount: string;
  /** Epoch ms after which the nonce is rejected. */
  expiresAt: number;
}

/** Bound the map so a flood of challenge requests can't grow memory without limit. */
const MAX_NONCES = 10000;

/**
 * Per-account cap on outstanding (unconsumed, unexpired) nonces, and a
 * DELIBERATE, DOCUMENTED trade-off between two imperfect options — read this
 * before changing either.
 *
 * Challenge issuance requires no proof of key possession, so anyone can
 * request a nonce for any syntactically valid-looking account, including a
 * real victim's own public on-chain account name (the whole point of an
 * on-chain identity is that it's public). Some form of denial-of-service
 * against a named victim is therefore possible without real request-level
 * rate limiting — which does not exist anywhere in this app today, and
 * building it is genuinely new infrastructure, out of scope here. Two
 * policies were tried for what happens once an account is at its cap:
 *
 *   - REJECT new issuance (tried, then reverted): closes the "flood evicts
 *     the victim's real in-flight nonce" race, but turns the same flood into
 *     a DETERMINISTIC, INDEFINITE lockout — the attacker keeps the account's
 *     5 slots full forever (nonces last `CHALLENGE_TTL_SECONDS`, so
 *     re-issuing every ~14 minutes suffices), and the victim's own
 *     `/challenge` calls get 429 the entire time. Total, guaranteed denial.
 *   - EVICT the account's own oldest nonce (current policy): a flood CAN
 *     invalidate the victim's specific in-flight nonce, forcing them to
 *     re-request — a real, bounded annoyance — but NEW issuance for that
 *     account is never blocked, so the victim can always obtain a fresh
 *     nonce and race to complete challenge→verify. Never a total lockout.
 *
 * Evict-oldest is the accepted policy: a probabilistic, bounded nuisance is
 * strictly preferable to a deterministic, unbounded one. Closing this
 * residual gap for real needs rate limiting or a proof-of-work style cost on
 * `/connectors/auth/challenge` — tracked as a known follow-up, not attempted
 * here.
 *
 * Eviction is scoped to the SAME account only — never a blind global
 * oldest-wins eviction — so a flood of requests for attacker-controlled
 * accounts can never evict a DIFFERENT, unrelated account's nonce.
 */
const MAX_NONCES_PER_ACCOUNT = 5;

export class AuthNonceStore {
  private nonces = new Map<string, NonceEntry>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Issue a single-use, TTL'd nonce bound to `apolloAccount`. See
   * `MAX_NONCES_PER_ACCOUNT`'s doc comment for the eviction policy and why. */
  issue(apolloAccount: string): { nonce: string; expiresAt: number } {
    this.sweep();
    const forAccount: string[] = [];
    for (const [n, entry] of this.nonces) {
      if (entry.apolloAccount === apolloAccount) forAccount.push(n);
    }
    if (forAccount.length >= MAX_NONCES_PER_ACCOUNT) {
      this.nonces.delete(forAccount[0]); // oldest (Map preserves insertion order)
    }
    // Global cap remains as a last-resort memory bound, independent of the
    // per-account scoping above.
    if (this.nonces.size >= MAX_NONCES) {
      const oldest = this.nonces.keys().next().value;
      if (oldest) this.nonces.delete(oldest);
    }
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = this.clock() + CHALLENGE_TTL_SECONDS * 1000;
    this.nonces.set(nonce, { apolloAccount, expiresAt });
    return { nonce, expiresAt };
  }

  /**
   * Consume `nonce` for `apolloAccount`. Returns true the FIRST time for a
   * matching, unexpired nonce — deleting the entry so it can never be replayed.
   * Returns false (without deleting) on an unknown nonce, an account mismatch,
   * or an expired nonce.
   */
  consume(nonce: string, apolloAccount: string): boolean {
    const entry = this.nonces.get(nonce);
    if (!entry) return false;
    if (entry.apolloAccount !== apolloAccount) return false;
    if (entry.expiresAt <= this.clock()) return false;
    this.nonces.delete(nonce);
    return true;
  }

  private sweep(): void {
    const now = this.clock();
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt <= now) this.nonces.delete(nonce);
    }
  }
}
