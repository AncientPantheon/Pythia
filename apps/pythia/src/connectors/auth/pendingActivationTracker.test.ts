import { describe, it, expect } from "vitest";
import {
  PendingActivationTracker,
  PENDING_ACTIVATION_TTL_MS,
  ACTIVATION_STUCK_GRACE_MS,
} from "./pendingActivationTracker.js";

const STANDARD_A = "₱.".padEnd(162, "a"); // arbitrary 162-char standard-shaped string
const SMART_A = "Π.".padEnd(162, "b"); // arbitrary 162-char smart-shaped string
const STANDARD_C = "₱.".padEnd(162, "c"); // second independent pair, standard half
const SMART_C = "Π.".padEnd(162, "d"); // second independent pair, smart half
const STANDARD_E = "₱.".padEnd(162, "e"); // a second STANDARD account (same classification as F)
const STANDARD_F = "₱.".padEnd(162, "f"); // paired with E despite both being Standard

describe("PendingActivationTracker", () => {
  it("never returns a pair when only one half has proven ownership", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, SMART_A);
    expect(tracker.beginActivation()).toBeNull();
  });

  it("returns exactly the pair once both halves prove, standard-then-smart order", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);

    const ready = tracker.beginActivation();
    expect(ready).not.toBeNull();
    expect(ready?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
  });

  it("returns exactly the pair once both halves prove, smart-then-standard order", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(SMART_A, STANDARD_A);
    tracker.recordProof(STANDARD_A, SMART_A);

    const ready = tracker.beginActivation();
    expect(ready).not.toBeNull();
    expect(ready?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
  });

  it("does not mutate state on read — a second beginActivation() without commit returns the same pair", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);

    const first = tracker.beginActivation();
    const second = tracker.beginActivation();
    expect(first?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
    expect(second?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
  });

  it("commitActivation drains exactly the pair the token was issued for", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);

    const ready = tracker.beginActivation();
    expect(ready).not.toBeNull();
    tracker.commitActivation(ready!.token);

    expect(tracker.beginActivation()).toBeNull();
  });

  it("a stale/unknown token is a no-op, not a throw", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);

    expect(() => tracker.commitActivation("never-issued-token")).not.toThrow();
    // The real pending pair survives an unrelated/unknown token's commit.
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
  });

  it("tracks two independent pairs without interference", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);
    tracker.recordProof(STANDARD_C, SMART_C);
    tracker.recordProof(SMART_C, STANDARD_C);

    const first = tracker.beginActivation();
    expect(first).not.toBeNull();
    tracker.commitActivation(first!.token);

    const second = tracker.beginActivation();
    expect(second).not.toBeNull();
    tracker.commitActivation(second!.token);

    expect(tracker.beginActivation()).toBeNull();
  });

  it("sweeps a half-proven pair that never completes once it's past its TTL", () => {
    let now = 0;
    const tracker = new PendingActivationTracker({ clock: () => now });
    tracker.recordProof(STANDARD_A, SMART_A); // only one half ever proves — abandoned

    now += PENDING_ACTIVATION_TTL_MS + 1;
    expect(tracker.sweepExpired()).toBe(1);
    expect(tracker.sweepExpired()).toBe(0); // already gone, nothing left to sweep

    // Even if the other half proves AFTER expiry, it's a fresh, still-only-
    // one-half-proven entry — not a resurrection of the swept one.
    tracker.recordProof(SMART_A, STANDARD_A);
    expect(tracker.beginActivation()).toBeNull();
  });

  it("an expired-but-fully-proven pair (both proofs landed BEFORE any TTL refresh could matter) is not offered by beginActivation(), and is removed by sweepExpired()", () => {
    let now = 0;
    const tracker = new PendingActivationTracker({ clock: () => now });
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A); // fully proven, ready — but never drained

    now += PENDING_ACTIVATION_TTL_MS + 1;
    expect(tracker.beginActivation()).toBeNull(); // too old to offer, even though ready
    expect(tracker.sweepExpired()).toBe(1);
  });

  it("a pair that completes its SECOND half close to the first proof's TTL boundary gets a fresh window — it is NOT lost (regression: TTL-refresh-on-completion fix)", () => {
    let now = 0;
    const tracker = new PendingActivationTracker({ clock: () => now });
    tracker.recordProof(STANDARD_A, SMART_A); // half proven at t=0, TTL would expire at t=TTL

    // The second half proves just before the FIRST proof's original TTL
    // would have expired it.
    now = PENDING_ACTIVATION_TTL_MS - 1;
    tracker.recordProof(SMART_A, STANDARD_A); // now fully proven — this must refresh the TTL

    // Advance well past the ORIGINAL (first-proof) expiry, but still within
    // the REFRESHED (completion-time) window.
    now = PENDING_ACTIVATION_TTL_MS - 1 + (PENDING_ACTIVATION_TTL_MS - 100);
    const ready = tracker.beginActivation();
    expect(ready).not.toBeNull(); // still offered — the refresh worked
    expect(ready?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
  });

  it("a pair that's been offered but never committed past the stuck grace period no longer blocks a fresher ready pair (regression: HIGH head-of-line-blocking fix)", () => {
    // Simulates a pair whose on-chain activation never confirms (e.g. it
    // was already active via a stale dualLinkCache read, or the chain
    // transaction otherwise never succeeds) — commitActivation() is never
    // called for it, exactly like settle() never firing for a resolve()
    // that never lands on-chain.
    let now = 0;
    const tracker = new PendingActivationTracker({ clock: () => now });
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A); // pair A/A ready first

    const firstOffer = tracker.beginActivation();
    expect(firstOffer?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
    // NOT committed — simulates the on-chain activation never confirming.

    // A second, genuinely independent pair becomes ready shortly after.
    now += 1000;
    tracker.recordProof(STANDARD_C, SMART_C);
    tracker.recordProof(SMART_C, STANDARD_C);

    // Still within the grace window — the original (older) pair is still
    // preferred, same as before this fix (no regression for the normal case).
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });

    // Once the stuck pair has been offered-but-uncommitted for longer than
    // the grace period, the fresher C/C pair must be offered instead — the
    // stuck pair no longer starves it.
    now = ACTIVATION_STUCK_GRACE_MS + 1;
    const second = tracker.beginActivation();
    expect(second?.pair).toEqual({ standard: STANDARD_C, smart: SMART_C });

    // The stuck pair is still committable — it isn't abandoned, just
    // deprioritized. Committing the fresher one first, then the stuck one,
    // drains both.
    tracker.commitActivation(second!.token);
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
    tracker.commitActivation(firstOffer!.token);
    expect(tracker.beginActivation()).toBeNull();
  });

  it("a stuck pair is still offered (and committable) when it is the ONLY ready candidate — never abandoned outright", () => {
    let now = 0;
    const tracker = new PendingActivationTracker({ clock: () => now });
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);

    const first = tracker.beginActivation();
    expect(first).not.toBeNull();

    now = ACTIVATION_STUCK_GRACE_MS + 1; // now well past the grace period
    // No other pair exists — the stuck one must still be offered rather
    // than beginActivation() returning null.
    const stillOffered = tracker.beginActivation();
    expect(stillOffered?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
    tracker.commitActivation(stillOffered!.token);
    expect(tracker.beginActivation()).toBeNull();
  });

  it("does not mislabel a pair when both proven accounts share the same Apollo classification", () => {
    // Two STANDARD (₱.) accounts, paired together — not a realistic on-chain
    // pairing (the Pact contract only ever pairs one Standard with one Smart),
    // but this tracker has no guard of its own against it, so document the
    // current fallback behavior explicitly rather than leaving it silently
    // untested. Asserting the EXACT (unsorted) shape here matters: a prior
    // version of this test sorted both sides before comparing, which passed
    // identically even if `standard`/`smart` were swapped — defeating the
    // point of documenting which field the fallback actually lands in.
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_E, STANDARD_F);
    tracker.recordProof(STANDARD_F, STANDARD_E);

    const ready = tracker.beginActivation();
    // `pairKey`'s `[a,b].sort()` fixes accountA = STANDARD_E, accountB =
    // STANDARD_F (lexicographic). `standard = isStandardApollo(accountA) ?
    // accountA : accountB` → STANDARD_E (true). `smart = isSmartApollo(accountA)
    // ? accountA : accountB` → STANDARD_F (isSmartApollo(accountA) is false,
    // so it falls back to accountB — which is STILL ₱.-prefixed, not a real
    // Smart account; this is the documented, current (non-)behavior, not
    // validated as a genuine dual-link pairing anywhere in this class).
    expect(ready?.pair).toEqual({ standard: STANDARD_E, smart: STANDARD_F });
  });

  it("ignores a self-referential proof (apolloAccount === counterpart) rather than leaving a dead, unprovable entry", () => {
    const tracker = new PendingActivationTracker();
    tracker.recordProof(STANDARD_A, STANDARD_A);
    expect(tracker.beginActivation()).toBeNull();

    // It didn't silently occupy a slot either — a real pair recorded right
    // after is entirely unaffected.
    tracker.recordProof(STANDARD_C, SMART_C);
    tracker.recordProof(SMART_C, STANDARD_C);
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_C, smart: SMART_C });
  });

  it("two DIFFERENT pairs whose accounts would collide under a naive '|'-joined key stay independent (regression: HIGH map-key-collision fix)", () => {
    // Pair 1: "₱.A|B..." and "Π.C...". Pair 2: "₱.A..." and "Π.B|C...". A
    // plain `[a,b].sort().join("|")` could produce the SAME string for both
    // (sort order aside, the joined text "A|B|C..."/"A|B|C..." collides) —
    // JSON.stringify-based keys must not. Each account carries a real ₱./Π.
    // prefix so `beginActivation()`'s standard/smart classification (a
    // separate concern from the key-collision fix under test here) resolves
    // unambiguously.
    const tracker = new PendingActivationTracker();
    const PART_A = "₱.A|B".padEnd(162, "1");
    const PART_B = "Π.C".padEnd(162, "2");
    const PART_C = "₱.A".padEnd(162, "3");
    const PART_D = "Π.B|C".padEnd(162, "4");

    tracker.recordProof(PART_A, PART_B);
    tracker.recordProof(PART_C, PART_D);
    // Neither pair is complete — recording halves of one must never have
    // silently completed (or corrupted) the other via a key collision.
    expect(tracker.beginActivation()).toBeNull();

    tracker.recordProof(PART_B, PART_A); // completes pair 1 only
    const ready = tracker.beginActivation();
    expect(ready).not.toBeNull();
    expect([ready?.pair.standard, ready?.pair.smart].sort()).toEqual([PART_A, PART_B].sort());
  });

  it("caps total outstanding pairs — filling past the cap evicts the OLDEST unproven entry, never a fully-proven ready one", () => {
    const tracker = new PendingActivationTracker({ maxPending: 2 });

    // Slot 1: a fully-proven, ready pair — must never be evicted.
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);
    // Slot 2: a half-proven, abandoned pair — the oldest UNPROVEN entry once
    // capacity is reached, so it's the one eviction targets.
    tracker.recordProof(STANDARD_C, SMART_C);
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });

    // At capacity (2/2). A brand-new half-proof for a THIRD pair forces an
    // eviction to make room — it must take slot 2 (unproven), never slot 1
    // (the ready pair).
    const STANDARD_G = "₱.".padEnd(162, "g");
    const SMART_G = "Π.".padEnd(162, "h");
    tracker.recordProof(STANDARD_G, SMART_G);

    // The ready pair from slot 1 is still there, untouched by the eviction.
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });

    // Slot 2's original half-proof was evicted: completing STANDARD_C/SMART_C
    // now starts an entirely fresh entry (needs both halves again from
    // scratch) — one new half-proof alone doesn't make it (or anything else)
    // ready. beginActivation() still returns only the untouched slot-1 pair.
    tracker.recordProof(SMART_C, STANDARD_C);
    expect(tracker.beginActivation()?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });
  });

  it("at capacity with EVERY entry already fully proven, a new half-proof is a no-op — no ready pair is ever dropped to make room", () => {
    const tracker = new PendingActivationTracker({ maxPending: 1 });

    // Slot 1: the only slot, fully proven and ready.
    tracker.recordProof(STANDARD_A, SMART_A);
    tracker.recordProof(SMART_A, STANDARD_A);
    const before = tracker.beginActivation();
    expect(before?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A });

    // At capacity (1/1), every entry is fully proven — there is nothing
    // evictable. A new half-proof must be silently dropped (not stored,
    // not overwriting the ready pair), per the `else return;` no-op branch.
    tracker.recordProof(STANDARD_C, SMART_C);
    const stillReady = tracker.beginActivation();
    expect(stillReady?.pair).toEqual({ standard: STANDARD_A, smart: SMART_A }); // unchanged

    // The dropped half-proof left no trace: completing its other half alone
    // doesn't make C/C ready (it would need `recordProof(STANDARD_C, ...)`
    // to have actually been stored, which it wasn't).
    tracker.commitActivation(before!.token); // free the slot
    tracker.recordProof(SMART_C, STANDARD_C); // only the SECOND half now recorded fresh
    expect(tracker.beginActivation()).toBeNull(); // still needs its other half
  });
});
