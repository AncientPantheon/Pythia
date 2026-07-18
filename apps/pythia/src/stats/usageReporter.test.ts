import { describe, it, expect } from "vitest";
import { SlotUsageMeter } from "./slotUsage.js";
import { UsageReporter } from "./usageReporter.js";
import type { HubServiceClient, UsageReport } from "../hub/serviceClient.js";

function fakeClient(onPost: (r: UsageReport) => void | never): HubServiceClient {
  return {
    postUsage: async (r: UsageReport) => {
      onPost(r);
      return { ok: true };
    },
  } as unknown as HubServiceClient;
}

function meter() {
  return new SlotUsageMeter({ clock: () => new Date("2026-07-05T00:00:00.000Z") });
}

describe("UsageReporter", () => {
  it("drains + posts a non-empty window, adding pondusVersion:1 per slot", async () => {
    const m = meter();
    const posts: UsageReport[] = [];
    const reporter = new UsageReporter({
      meter: m,
      client: () => fakeClient((r) => posts.push(r)),
      reportEnabled: () => true,
    });
    m.record("s1", "k:op", true, true, 12.5);
    await reporter.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0].slots[0]).toMatchObject({
      id: "s1",
      keyedRequests: 1,
      keyedPondus: 12.5,
      pondusVersion: 1,
    });
    expect(m.isEmpty()).toBe(true); // drained
  });

  it("with the toggle OFF, drains and DISCARDS the window (no post, no mint)", async () => {
    const m = meter();
    const posts: UsageReport[] = [];
    const reporter = new UsageReporter({
      meter: m,
      client: () => fakeClient((r) => posts.push(r)),
      reportEnabled: () => false,
    });
    m.record("s1", "k:op", true, true, 5);
    await reporter.tick();
    expect(posts).toHaveLength(0);
    expect(m.isEmpty()).toBe(true); // discarded
  });

  it("skips an empty window entirely (no post)", async () => {
    const posts: UsageReport[] = [];
    const reporter = new UsageReporter({
      meter: meter(),
      client: () => fakeClient((r) => posts.push(r)),
      reportEnabled: () => true,
    });
    await reporter.tick();
    expect(posts).toHaveLength(0);
  });

  it("retries a failed window UNCHANGED next tick (idempotent)", async () => {
    const m = meter();
    let fail = true;
    const posts: UsageReport[] = [];
    const client = {
      postUsage: async (r: UsageReport) => {
        posts.push(r);
        if (fail) throw new Error("hub /usage 500");
        return { ok: true };
      },
    } as unknown as HubServiceClient;
    const reporter = new UsageReporter({ meter: m, client: () => client, reportEnabled: () => true });
    m.record("s1", "k:op", true, true, 5);
    await reporter.tick(); // fails → pending
    expect(posts).toHaveLength(1);
    fail = false;
    await reporter.tick(); // retries the SAME window
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]); // byte-identical
    // and the meter stays drained — a new window doesn't clobber the pending one
    expect(m.isEmpty()).toBe(true);
  });

  it("does not drain when the hub is unconfigured (keeps accumulating)", async () => {
    const m = meter();
    const reporter = new UsageReporter({ meter: m, client: () => null, reportEnabled: () => true });
    m.record("s1", "k:op", true, true, 5);
    await reporter.tick();
    expect(m.isEmpty()).toBe(false);
  });
});
