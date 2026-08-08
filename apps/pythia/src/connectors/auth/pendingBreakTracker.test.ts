import { describe, it, expect } from "vitest";
import { PendingBreakTracker } from "./pendingBreakTracker.js";

const KEY_A = "₱.aaa|Π.bbb";
const KEY_B = "₱.ccc|Π.ddd";

describe("PendingBreakTracker", () => {
  it("queues a break and exposes it via beginBreak WITHOUT removing it", () => {
    const t = new PendingBreakTracker();
    const token = t.recordBreak(KEY_A);
    expect(t.hasPending()).toBe(true);
    const b = t.beginBreak();
    expect(b).toEqual({ dualLinkKey: KEY_A, token });
    // beginBreak did not remove it — a failed fire must retry.
    expect(t.hasPending()).toBe(true);
    expect(t.beginBreak()).toEqual({ dualLinkKey: KEY_A, token });
  });

  it("commitBreak removes exactly the committed token (confirmed on-chain success)", () => {
    const t = new PendingBreakTracker();
    const token = t.recordBreak(KEY_A);
    t.commitBreak(token);
    expect(t.hasPending()).toBe(false);
    expect(t.beginBreak()).toBeNull();
  });

  it("dedupes the same key (one pending revoke per link) and returns the existing token", () => {
    const t = new PendingBreakTracker();
    const first = t.recordBreak(KEY_A);
    const second = t.recordBreak(KEY_A);
    expect(second).toBe(first);
    expect(t.pendingCount()).toBe(1);
  });

  it("fires FIFO across multiple distinct keys", () => {
    const t = new PendingBreakTracker();
    t.recordBreak(KEY_A);
    t.recordBreak(KEY_B);
    expect(t.beginBreak()?.dualLinkKey).toBe(KEY_A);
    t.commitBreak(t.beginBreak()!.token);
    expect(t.beginBreak()?.dualLinkKey).toBe(KEY_B);
  });

  it("an unknown commit token is ignored", () => {
    const t = new PendingBreakTracker();
    t.recordBreak(KEY_A);
    t.commitBreak("brk_999");
    expect(t.hasPending()).toBe(true);
  });
});
