import { describe, it, expect } from "vitest";
import { NodePool } from "./nodePool.js";
import type { HubServiceClient, NodesFeed } from "../hub/serviceClient.js";
import type { DialNode } from "../dial/index.js";

// The Upload Pool is the operator's node list — the read fallback and, when the
// hub feed is off/down, the read pool itself. There is no separate config-seed tier.
const UPLOAD: DialNode[] = [
  { id: "up-a", url: "https://a.up" },
  { id: "up-b", url: "https://b.up" },
];

function stubClient(feed: NodesFeed | (() => Promise<NodesFeed>)): HubServiceClient {
  const fetchNodes = typeof feed === "function" ? feed : async () => feed;
  return { fetchNodes } as unknown as HubServiceClient;
}

function hubFeed(ids: string[]): NodesFeed {
  return {
    slots: ids.map((id) => ({
      id,
      url: `https://${id}:1848`,
      networkId: "stoa",
      operator: null,
      atTip: true,
      height: 1,
    })),
    refreshAfter: 60,
  };
}

describe("NodePool.pickReadPair", () => {
  it("returns null with no feed AND an empty Upload Pool (→ read 503)", () => {
    expect(new NodePool({ uploadNodes: () => [] }).pickReadPair()).toBeNull();
  });

  it("with the feed off, serves reads from the Upload Pool (rotating)", () => {
    const pool = new NodePool({ uploadNodes: () => UPLOAD });
    expect(pool.pickReadPair()?.primary.id).toBe("up-a");
    expect(pool.pickReadPair()?.primary.id).toBe("up-b");
    expect(pool.pickReadPair()?.primary.id).toBe("up-a"); // wraps
  });

  it("with hub slots, rotates PRIMARY across the fleet and uses an Upload node as fallback", async () => {
    const pool = new NodePool({
      uploadNodes: () => UPLOAD,
      client: stubClient(hubFeed(["10.0.0.1", "10.0.0.2"])),
    });
    await pool.refreshNow();
    const p0 = pool.pickReadPair()!;
    const p1 = pool.pickReadPair()!;
    expect(p0.primary.id).toBe("10.0.0.1");
    expect(p1.primary.id).toBe("10.0.0.2");
    for (const p of [p0, p1]) {
      expect(UPLOAD.map((u) => u.id)).toContain(p.fallback.id);
    }
  });

  it("with hub slots but an empty Upload Pool, the fallback is another hub slot", async () => {
    const pool = new NodePool({
      uploadNodes: () => [],
      client: stubClient(hubFeed(["10.0.0.1", "10.0.0.2"])),
    });
    await pool.refreshNow();
    const p = pool.pickReadPair()!;
    expect(p.primary.id).toBe("10.0.0.1");
    expect(p.fallback.id).toBe("10.0.0.2");
  });

  it("keeps last-good slots when a refresh fails (feed blip)", async () => {
    let call = 0;
    const pool = new NodePool({
      uploadNodes: () => UPLOAD,
      client: stubClient(async () => {
        call += 1;
        if (call === 1) return hubFeed(["10.0.0.1"]);
        throw new Error("hub /nodes 503");
      }),
    });
    await pool.refreshNow(); // ok → 1 slot
    await pool.refreshNow(); // throws → keeps last-good
    expect(pool.hubSlotCount()).toBe(1);
    expect(pool.pickReadPair()?.primary.id).toBe("10.0.0.1");
  });

  it("feedHealth reflects configured / ok / slot count", async () => {
    const pool = new NodePool({
      uploadNodes: () => UPLOAD,
      client: stubClient(hubFeed(["10.0.0.1"])),
    });
    await pool.refreshNow();
    expect(pool.feedHealth()).toMatchObject({ configured: true, ok: true, slots: 1 });
  });
});

describe("NodePool.operatorForSlot", () => {
  it("returns the operator for a hub slot, null for unearning, undefined for a non-hub id", async () => {
    const feed: NodesFeed = {
      slots: [
        { id: "s1", url: "https://s1:1848", networkId: "stoa", operator: "k:abc", atTip: true, height: 1 },
        { id: "s2", url: "https://s2:1848", networkId: "stoa", operator: null, atTip: true, height: 1 },
      ],
      refreshAfter: 60,
    };
    const pool = new NodePool({ client: stubClient(feed), uploadNodes: () => UPLOAD });
    await pool.refreshNow();
    expect(pool.operatorForSlot("s1")).toBe("k:abc");
    expect(pool.operatorForSlot("s2")).toBeNull();
    expect(pool.operatorForSlot("up-a")).toBeUndefined();
    pool.stop();
  });
});

describe("NodePool refresh cadence + staleness TTL", () => {
  it("nextPollDelayMs honors the feed's refreshAfter, clamped to min/max", async () => {
    let after = 30;
    const pool = new NodePool({
      client: stubClient(() => Promise.resolve({ slots: [], refreshAfter: after })),
      uploadNodes: () => UPLOAD,
    });
    expect(pool.nextPollDelayMs()).toBe(60_000); // no poll yet → default
    await pool.refreshNow();
    expect(pool.nextPollDelayMs()).toBe(30_000);
    after = 5;
    await pool.refreshNow();
    expect(pool.nextPollDelayMs()).toBe(15_000); // clamped to min
    after = 9999;
    await pool.refreshNow();
    expect(pool.nextPollDelayMs()).toBe(300_000); // clamped to max
  });

  it("drops stale hub slots after the TTL when the feed keeps failing", async () => {
    let now = 1000;
    let ok = true;
    const pool = new NodePool({
      client: stubClient(() => (ok ? Promise.resolve(hubFeed(["s1"])) : Promise.reject(new Error("feed down")))),
      uploadNodes: () => UPLOAD,
      clock: () => now,
      staleMs: 100_000,
    });
    await pool.refreshNow(); // good at t=1000
    expect(pool.hubSlotCount()).toBe(1);

    ok = false;
    now = 1000 + 99_999;
    await pool.refreshNow(); // within TTL → keep the last-good slots
    expect(pool.hubSlotCount()).toBe(1);

    now = 1000 + 100_000;
    await pool.refreshNow(); // past TTL → drop; reads fall back to the Upload Pool
    expect(pool.hubSlotCount()).toBe(0);
    expect(pool.pickReadPair()?.primary.id).toMatch(/^up-/);
  });
});
