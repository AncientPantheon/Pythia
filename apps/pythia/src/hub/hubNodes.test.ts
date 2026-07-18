import { describe, it, expect } from "vitest";
import { enrichHubNodes } from "./hubNodes.js";
import type { AdvertisedSlot } from "./serviceClient.js";
import type { NodeReachability } from "../health/probeNodes.js";

const slot = (over: Partial<AdvertisedSlot> & { id: string; url: string }): AdvertisedSlot => ({
  networkId: "stoa",
  operator: null,
  atTip: true,
  height: 1,
  ...over,
});

const reach = (url: string, reachable: boolean, reason: NodeReachability["reason"] = null): NodeReachability => ({
  url,
  reachable,
  reason,
});

describe("enrichHubNodes", () => {
  it("merges each slot with its reachability + reason by url", () => {
    const nodes = enrichHubNodes(
      [slot({ id: "1.1.1.1", url: "https://a" }), slot({ id: "2.2.2.2", url: "https://b" })],
      [reach("https://a", true), reach("https://b", false, "refused")],
    );
    expect(nodes.find((n) => n.id === "1.1.1.1")).toMatchObject({ reachable: true, reason: null });
    expect(nodes.find((n) => n.id === "2.2.2.2")).toMatchObject({ reachable: false, reason: "refused" });
  });

  it("sorts by slotStoicismEarned (decimal string) desc when earnings are present", () => {
    const nodes = enrichHubNodes(
      [
        slot({ id: "low", url: "https://low", slotStoicismEarned: "12.5" }),
        slot({ id: "high", url: "https://high", slotStoicismEarned: "1234.5678" }),
        slot({ id: "mid", url: "https://mid", slotStoicismEarned: "100" }),
      ],
      [reach("https://low", true), reach("https://high", true), reach("https://mid", true)],
    );
    expect(nodes.map((n) => n.id)).toEqual(["high", "mid", "low"]);
  });

  it("falls back to reachable-first (then id) when no earnings are present", () => {
    const nodes = enrichHubNodes(
      [slot({ id: "z-down", url: "https://z" }), slot({ id: "a-up", url: "https://a" }), slot({ id: "b-up", url: "https://b" })],
      [reach("https://z", false, "timeout"), reach("https://a", true), reach("https://b", true)],
    );
    // reachable nodes first (sorted by id), unreachable last
    expect(nodes.map((n) => n.id)).toEqual(["a-up", "b-up", "z-down"]);
  });

  it("passes earnings fields through to the enriched node", () => {
    const [n] = enrichHubNodes(
      [slot({ id: "x", url: "https://x", operatorPythXP: 48210, operatorPythLevel: 7, slotStoicismEarned: "9.9" })],
      [reach("https://x", true)],
    );
    expect(n).toMatchObject({ operatorPythXP: 48210, operatorPythLevel: 7, slotStoicismEarned: "9.9" });
  });

  it("defaults a slot with no probe result to unreachable", () => {
    const [n] = enrichHubNodes([slot({ id: "x", url: "https://x" })], []);
    expect(n).toMatchObject({ reachable: false, reason: "unreachable" });
  });
});
