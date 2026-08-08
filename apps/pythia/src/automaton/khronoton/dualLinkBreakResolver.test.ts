import { describe, it, expect } from "vitest";
import { createDualLinkBreakResolver, DUAL_LINK_BREAK_RESOLVER } from "./dualLinkBreakResolver.js";
import { PendingBreakTracker } from "../../connectors/auth/pendingBreakTracker.js";

const KEY = "₱.aaa|Π.bbb";

describe("dualLinkBreakResolver", () => {
  it("has the canonical evented single-tx shape", () => {
    const r = createDualLinkBreakResolver(new PendingBreakTracker());
    expect(DUAL_LINK_BREAK_RESOLVER).toBe("dual-link-break");
    expect(r.kind).toBe("single-tx");
    expect(r.evented).toBe(true);
  });

  it("resolve() fills payload.dualAPI from the oldest queued break and plans its token", () => {
    const t = new PendingBreakTracker();
    const token = t.recordBreak(KEY);
    const r = createDualLinkBreakResolver(t);
    expect(r.resolve()).toEqual({ plan: [token], payload: { dualAPI: KEY } });
    // resolve() did NOT drain — still pending until settle.
    expect(t.hasPending()).toBe(true);
  });

  it("resolve() returns a no-op (empty plan, blank dualAPI) when nothing is queued", () => {
    const r = createDualLinkBreakResolver(new PendingBreakTracker());
    expect(r.resolve()).toEqual({ plan: [], payload: { dualAPI: "" } });
  });

  it("settle() commits (drains) exactly the sent break; a no-op plan drains nothing", () => {
    const t = new PendingBreakTracker();
    t.recordBreak(KEY);
    const r = createDualLinkBreakResolver(t);
    const { plan } = r.resolve();
    r.settle(plan);
    expect(t.hasPending()).toBe(false);
    // settling an empty plan is safe
    r.settle([]);
    expect(t.hasPending()).toBe(false);
  });
});
