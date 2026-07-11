import { randomBytes, randomUUID } from "node:crypto";
import { CHALLENGE_TTL_SECONDS } from "./canonicalMessage.js";

/**
 * In-memory verification state for the connector-linking flow.
 *
 * Deliberately EPHEMERAL — a transient prove-ownership handshake, not durable
 * state. A restart just means the user re-verifies. Two maps, both TTL-swept:
 *   - `challenges`: nonce → the (session, standard, smart) it was issued for,
 *   - `proven`: sessionId → (apollo-account → expiry) that verified.
 *
 * Keyed by an opaque, unguessable session id carried in the browser's
 * `pythia_link` cookie. Pythia holds no key here — the proof is the caller's
 * signature, verified against the on-chain public key elsewhere.
 */
export interface Challenge {
  nonce: string;
  sessionId: string;
  standard: string;
  smart: string;
  /** Epoch ms after which the challenge is rejected. */
  expiresAt: number;
  /** Accounts already consumed under this nonce — each half's signature is
   * single-use (replay-safe), but the challenge stays valid for the OTHER half
   * so the user can prove it in a second visit (a different Codex). */
  consumed: Set<string>;
}

/** Bound the maps so a flood of sessions can't grow memory without limit. */
const MAX_SESSIONS = 5000;
const MAX_CHALLENGES = 10000;
const PROVEN_TTL_MS = 60 * 60 * 1000; // an ownership proof is honoured for 1h

class VerifyStore {
  private challenges = new Map<string, Challenge>();
  private proven = new Map<string, Map<string, number>>();

  /** A fresh opaque session id for the `pythia_link` cookie. */
  newSessionId(): string {
    return randomUUID();
  }

  /** Issue a single-use, TTL'd challenge binding a nonce to the pair + session. */
  issue(sessionId: string, standard: string, smart: string): Challenge {
    this.sweep();
    if (this.challenges.size >= MAX_CHALLENGES) {
      // Drop the oldest (insertion-ordered) to make room.
      const oldest = this.challenges.keys().next().value;
      if (oldest) this.challenges.delete(oldest);
    }
    const nonce = randomBytes(24).toString("hex");
    const challenge: Challenge = {
      nonce,
      sessionId,
      standard,
      smart,
      expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
      consumed: new Set(),
    };
    this.challenges.set(nonce, challenge);
    return challenge;
  }

  /**
   * Consume `account`'s slot under `nonce`. Returns true the FIRST time (caller
   * may then record the proof), false on a replay of an already-used
   * (nonce, account) or an unknown/expired nonce. Keeps each signature single-use
   * without burning the whole challenge — the sibling half can still be proven.
   */
  consumeHalf(nonce: string, account: string): boolean {
    const challenge = this.get(nonce);
    if (!challenge) return false;
    if (challenge.consumed.has(account)) return false;
    challenge.consumed.add(account);
    return true;
  }

  /** The live (unexpired) challenge for a nonce, or null. */
  get(nonce: string): Challenge | null {
    const challenge = this.challenges.get(nonce);
    if (!challenge) return null;
    if (challenge.expiresAt <= Date.now()) {
      this.challenges.delete(nonce);
      return null;
    }
    return challenge;
  }

  /** Record that `account` proved ownership for `sessionId`. */
  markProven(sessionId: string, account: string): void {
    let accounts = this.proven.get(sessionId);
    if (!accounts) {
      if (this.proven.size >= MAX_SESSIONS) {
        const oldest = this.proven.keys().next().value;
        if (oldest) this.proven.delete(oldest);
      }
      accounts = new Map();
      this.proven.set(sessionId, accounts);
    }
    accounts.set(account, Date.now() + PROVEN_TTL_MS);
  }

  /** The apollo accounts still proven (unexpired) for a session. */
  provenAccounts(sessionId: string): string[] {
    const accounts = this.proven.get(sessionId);
    if (!accounts) return [];
    const now = Date.now();
    const out: string[] = [];
    for (const [account, expiresAt] of accounts) {
      if (expiresAt > now) out.push(account);
      else accounts.delete(account);
    }
    return out;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    }
  }
}

export const verifyStore = new VerifyStore();
