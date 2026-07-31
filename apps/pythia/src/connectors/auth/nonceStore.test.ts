import { describe, it, expect } from "vitest";
import { AuthNonceStore } from "./nonceStore.js";
import { CHALLENGE_TTL_SECONDS } from "../verify/canonicalMessage.js";

describe("AuthNonceStore", () => {
  it("consumes a fresh nonce for the right account exactly once (replay rejected)", () => {
    const store = new AuthNonceStore();
    const { nonce } = store.issue("₱.alice");
    expect(store.consume(nonce, "₱.alice")).toBe(true);
    // A second consume of the same nonce must fail — the whole point of a
    // single-use nonce is that a captured challenge/verify pair can't be replayed.
    expect(store.consume(nonce, "₱.alice")).toBe(false);
  });

  it("rejects consume when the account does not match who the nonce was issued to", () => {
    const store = new AuthNonceStore();
    const { nonce } = store.issue("₱.alice");
    expect(store.consume(nonce, "₱.mallory")).toBe(false);
    // The nonce isn't burned by a mismatched attempt — the legitimate owner can
    // still use it (mismatch is a different failure mode than replay/expiry).
    expect(store.consume(nonce, "₱.alice")).toBe(true);
  });

  it("rejects consume of a nonce that was never issued", () => {
    const store = new AuthNonceStore();
    expect(store.consume("not-a-real-nonce", "₱.alice")).toBe(false);
  });

  it("rejects consume once the nonce's TTL has elapsed, via an injected clock", () => {
    let now = 1_000_000;
    const store = new AuthNonceStore(() => now);
    const { nonce, expiresAt } = store.issue("₱.alice");
    expect(expiresAt).toBe(now + CHALLENGE_TTL_SECONDS * 1000);
    now = expiresAt; // exactly at expiry — already past the valid window
    expect(store.consume(nonce, "₱.alice")).toBe(false);
  });

  it("evicts an account's own OLDEST outstanding nonce once it's at its per-account cap — never blocks new issuance", () => {
    const store = new AuthNonceStore();
    const first = store.issue("₱.alice"); // will be evicted once the cap is exceeded
    for (let i = 0; i < 4; i++) store.issue("₱.alice"); // 5 total outstanding now (the cap)

    // A 6th issuance for the SAME account always succeeds (never rejected) —
    // it evicts the oldest (`first`) to make room.
    const sixth = store.issue("₱.alice");
    expect(sixth.nonce).not.toBe(first.nonce);

    expect(store.consume(first.nonce, "₱.alice")).toBe(false); // evicted
    expect(store.consume(sixth.nonce, "₱.alice")).toBe(true); // still valid
  });

  it("issuing many nonces for one account never evicts or blocks a DIFFERENT account's outstanding nonce", () => {
    const store = new AuthNonceStore();
    const alice = store.issue("₱.alice");

    // Flood account "bob" well past his own 5-slot cap — none of this may
    // touch alice's entry. Assert each of bob's issuances individually
    // succeeds (proving his cap is tracked independently, not shared/global —
    // a regression to a global counter would make some of these silently
    // behave differently once alice's 1 entry is already counted).
    for (let i = 0; i < 8; i++) {
      const b = store.issue("₱.bob");
      expect(b.nonce).toBeTruthy();
    }

    // Alice's original nonce is untouched by bob's flood.
    expect(store.consume(alice.nonce, "₱.alice")).toBe(true);
  });
});
