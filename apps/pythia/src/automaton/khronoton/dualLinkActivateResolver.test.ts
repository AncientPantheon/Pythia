import { describe, it, expect, vi } from "vitest";
import { getServerResolver } from "@ancientpantheon/khronoton-core/server";
import { PendingActivationTracker as RealPendingActivationTracker } from "../../connectors/auth/pendingActivationTracker.js";
import type { PendingActivationTracker } from "../../connectors/auth/pendingActivationTracker.js";
import {
  DUAL_LINK_ACTIVATE_RESOLVER,
  createDualLinkActivateResolver,
  registerDualLinkActivateResolver,
} from "./dualLinkActivateResolver.js";

/** A minimal fake standing in for `PendingActivationTracker` — cast to the real type
 *  the way the plan calls for ("fake/spy `PendingActivationTracker`"). */
function fakeTracker(beginActivation: () => ReturnType<PendingActivationTracker["beginActivation"]>) {
  return {
    beginActivation: vi.fn(beginActivation),
    commitActivation: vi.fn(),
  } as unknown as PendingActivationTracker;
}

describe("dual-link-activate server resolver", () => {
  it("declares itself EVENTED (event-driven, never scheduled) — khronoton-core forces it scheduleless", () => {
    const r = createDualLinkActivateResolver(fakeTracker(() => null));
    expect(r.kind).toBe("single-tx");
    expect(r.evented).toBe(true);
  });

  it("resolve() with nothing pending returns the empty/no-op payload shape and an empty plan", () => {
    const tracker = fakeTracker(() => null);
    const r = createDualLinkActivateResolver(tracker);
    const { plan, payload } = r.resolve();
    expect(plan).toEqual([]);
    expect(payload).toEqual({ standardApollo: "", smartApollo: "" });
  });

  it("resolve() with a ready pair returns that pair's accounts in the payload and a non-empty plan", () => {
    const tracker = fakeTracker(() => ({
      pair: { standard: "₱std-account", smart: "Πsmart-account" },
      token: "the-token",
    }));
    const r = createDualLinkActivateResolver(tracker);
    const { plan, payload } = r.resolve();
    expect(plan).toEqual(["the-token"]);
    expect(payload).toEqual({ standardApollo: "₱std-account", smartApollo: "Πsmart-account" });
  });

  it("settle() with a real plan calls commitActivation with the right token", () => {
    const tracker = fakeTracker(() => null);
    const r = createDualLinkActivateResolver(tracker);
    r.settle(["the-token"]);
    expect(tracker.commitActivation).toHaveBeenCalledWith("the-token");
  });

  it("settle() with an empty plan is a no-op (does not call commitActivation)", () => {
    const tracker = fakeTracker(() => null);
    const r = createDualLinkActivateResolver(tracker);
    r.settle([]);
    expect(tracker.commitActivation).not.toHaveBeenCalled();
  });

  it("registers under the canonical `dual-link-activate` name for the tick to find", () => {
    const tracker = fakeTracker(() => null);
    registerDualLinkActivateResolver(tracker);
    const reg = getServerResolver(DUAL_LINK_ACTIVATE_RESOLVER);
    expect(reg?.kind).toBe("single-tx");
  });

  it("integration: a REAL PendingActivationTracker, recorded/resolved/settled through the real resolver, actually cooperates end to end", () => {
    // Unlike every test above (which fakes the tracker), this one proves the
    // two real Wave-1/Wave-2 pieces actually work together — the same
    // real-collaborator pattern pythFlushResolver.test.ts already uses with a
    // real PythLedger.
    const STANDARD = "₱.".padEnd(162, "x");
    const SMART = "Π.".padEnd(162, "y");
    const tracker = new RealPendingActivationTracker();
    const resolver = createDualLinkActivateResolver(tracker);

    // Nothing recorded yet — real resolve() is the genuine empty/no-op shape.
    expect(resolver.resolve()).toEqual({
      plan: [],
      payload: { standardApollo: "", smartApollo: "" },
    });

    // Only one half proven — still nothing to activate.
    tracker.recordProof(STANDARD, SMART);
    expect(resolver.resolve()).toEqual({
      plan: [],
      payload: { standardApollo: "", smartApollo: "" },
    });

    // Both halves proven — resolve() now returns the real pair + a real token.
    tracker.recordProof(SMART, STANDARD);
    const { plan, payload } = resolver.resolve();
    expect(payload).toEqual({ standardApollo: STANDARD, smartApollo: SMART });
    expect(plan).toHaveLength(1);

    // A repeated resolve() before settle() is stable (non-mutating read).
    expect(resolver.resolve().payload).toEqual({ standardApollo: STANDARD, smartApollo: SMART });

    // settle() on confirmed success actually drains it via the REAL tracker —
    // a subsequent resolve() goes back to the empty/no-op shape.
    resolver.settle(plan);
    expect(resolver.resolve()).toEqual({
      plan: [],
      payload: { standardApollo: "", smartApollo: "" },
    });
  });
});
