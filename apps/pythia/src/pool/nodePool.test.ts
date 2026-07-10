import { describe, it, expect } from "vitest";
import { NodePool } from "./nodePool.js";
import type { HubServiceClient, NodesFeed } from "../hub/serviceClient.js";
import type { SourceConfig } from "../config/index.js";

const SEEDS: SourceConfig[] = [
  { id: "seed-a", url: "https://a.seed", role: "primary", chain: "stoa" },
  { id: "seed-b", url: "https://b.seed", role: "fallback", chain: "stoa" },
];

function stubClient(feed: NodesFeed | (() => Promise<NodesFeed>)): HubServiceClient {
  const fetchNodes = typeof feed === "function" ? feed : async () => feed;
  return { fetchNodes } as unknown as HubServiceClient;
}

describe("NodePool.pickReadPair", () => {
  it("with no hub slots, rotates the two seeds (today's behavior)", () => {
    const pool = new NodePool({ seeds: SEEDS });
    expect(pool.pickReadPair()).toEqual({ primary: SEEDS[0], fallback: SEEDS[1] });
    expect(pool.pickReadPair()).toEqual({ primary: SEEDS[1], fallback: SEEDS[0] });
  });

  it("with hub slots, rotates PRIMARY across the fleet and keeps a SEED fallback", async () => {
    const pool = new NodePool({
      seeds: SEEDS,
      client: stubClient({
        slots: [
          { id: "10.0.0.1", url: "https://10.0.0.1:1848", networkId: "stoa", operator: "k:x", atTip: true, height: 9 },
          { id: "10.0.0.2", url: "https://10.0.0.2:1848", networkId: "stoa", operator: "k:y", atTip: true, height: 9 },
        ],
        refreshAfter: 60,
      }),
    });
    await pool.refreshNow();
    expect(pool.hubSlotCount()).toBe(2);

    const p0 = pool.pickReadPair();
    const p1 = pool.pickReadPair();
    const p2 = pool.pickReadPair();
    expect(p0.primary.id).toBe("10.0.0.1"); // rotates across hub slots
    expect(p1.primary.id).toBe("10.0.0.2");
    expect(p2.primary.id).toBe("10.0.0.1"); // wraps
    // fallback is ALWAYS a seed — a dead hub node fails over to a known-good seed.
    for (const p of [p0, p1, p2]) {
      expect(SEEDS.map((s) => s.id)).toContain(p.fallback.id);
    }
  });

  it("keeps last-good slots when a refresh fails (never drops to zero on a blip)", async () => {
    let call = 0;
    const pool = new NodePool({
      seeds: SEEDS,
      client: stubClient(async () => {
        call += 1;
        if (call === 1) {
          return {
            slots: [{ id: "10.0.0.1", url: "https://10.0.0.1:1848", networkId: "stoa", operator: null, atTip: true, height: 1 }],
            refreshAfter: 60,
          };
        }
        throw new Error("hub /nodes 503");
      }),
    });
    await pool.refreshNow(); // ok → 1 slot
    await pool.refreshNow(); // throws → keeps last-good
    expect(pool.hubSlotCount()).toBe(1);
    expect(pool.pickReadPair().primary.id).toBe("10.0.0.1");
  });
});
