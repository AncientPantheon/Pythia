import { describe, it, expect } from "vitest";
import { createEventDrivenActivator } from "./dualLinkActivateTrigger.js";

/** A tiny fake queue: `depth` ready pairs, each successful fire drains one. */
function fakeQueue(depth: number, fireResult: (n: number) => boolean = () => true) {
  let remaining = depth;
  const fires: number[] = [];
  return {
    fires,
    hasReadyPair: () => remaining > 0,
    fireOnce: async () => {
      const n = fires.length + 1;
      fires.push(n);
      const ok = fireResult(n);
      if (ok) remaining -= 1; // a successful fire commits+removes its pair
      return ok;
    },
  };
}

describe("createEventDrivenActivator", () => {
  it("drains every ready pair one-by-one until the queue is empty", async () => {
    const q = fakeQueue(3);
    const activate = createEventDrivenActivator(q);
    await activate();
    expect(q.fires).toHaveLength(3); // fired once per ready pair
    expect(q.hasReadyPair()).toBe(false);
  });

  it("never fires when nothing is ready (no blank A_LinkDualApiKey)", async () => {
    const q = fakeQueue(0);
    const activate = createEventDrivenActivator(q);
    await activate();
    expect(q.fires).toHaveLength(0);
  });

  it("stops the drain on the first fire that doesn't succeed — the pair stays ready", async () => {
    // 3 ready; the 2nd fire fails → drain stops with the pair still queued.
    const q = fakeQueue(3, (n) => n !== 2);
    const activate = createEventDrivenActivator(q);
    await activate();
    // fire 1 (ok, drains one) + fire 2 (fails, stops) = 2 attempts; 2 pairs remain.
    expect(q.fires).toHaveLength(2);
    expect(q.hasReadyPair()).toBe(true);
  });

  it("is single-flight: a concurrent event doesn't double-fire, it re-runs the drain", async () => {
    // fireOnce resolves on a controllable gate so we can overlap two activate() calls.
    let remaining = 2;
    const fires: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstFire = true;
    const activate = createEventDrivenActivator({
      hasReadyPair: () => remaining > 0,
      fireOnce: async () => {
        fires.push(1);
        if (firstFire) {
          firstFire = false;
          await gate; // hold the first drain open
        }
        remaining -= 1;
        return true;
      },
    });

    const first = activate(); // starts draining, parked on the gate mid-first-fire
    await Promise.resolve();
    const second = activate(); // concurrent event → must NOT start a parallel drain
    release();
    await Promise.all([first, second]);

    // Exactly 2 fires total (one per pair), never doubled by the concurrent call.
    expect(fires).toHaveLength(2);
    expect(remaining).toBe(0);
  });
});
