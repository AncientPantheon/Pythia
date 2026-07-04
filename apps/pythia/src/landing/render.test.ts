import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderSources, renderConnectors, createRefreshLoop } from "./render.js";
import { makeFakeDocument, type FakeElement } from "./testDom.js";
import type { HealthSnapshot } from "../health/index.js";
import type { ConnectorConfig } from "../config/index.js";

// A minimal document seam is injected into the render functions so they are
// testable in the node env with no jsdom dependency. makeFakeDocument builds
// elements that record tag, text, attributes, dataset, and children.

const GREEN_SNAPSHOT: HealthSnapshot = {
  active: { sourceId: "p", url: "https://p.example" },
  routing: "primary",
  sources: [
    { id: "p", url: "https://p.example", role: "primary", reachable: true },
    { id: "f", url: "https://f.example", role: "fallback", reachable: true },
  ],
};

const FALLBACK_SNAPSHOT: HealthSnapshot = {
  active: { sourceId: "f", url: "https://f.example" },
  routing: "fallback",
  sources: [
    { id: "p", url: "https://p.example", role: "primary", reachable: false },
    { id: "f", url: "https://f.example", role: "fallback", reachable: true },
  ],
};

const DOWN_SNAPSHOT: HealthSnapshot = {
  active: { sourceId: "p", url: "https://p.example" },
  routing: "unreachable",
  sources: [
    { id: "p", url: "https://p.example", role: "primary", reachable: false },
    { id: "f", url: "https://f.example", role: "fallback", reachable: false },
  ],
};

function colorsOf(container: FakeElement): string[] {
  // Each source row carries its indicator color on the dot's data-color.
  const dots = container.querySelectorAll("[data-color]");
  return dots.map((d) => d.dataset.color);
}

describe("renderSources", () => {
  it("paints one row per source with the T5.1-derived color (green nominal)", () => {
    // On a nominal primary snapshot both reachable sources read green, and there
    // is exactly one row per source — the row count is data-driven, not hardcoded.
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderSources(container, GREEN_SNAPSHOT.sources, GREEN_SNAPSHOT.routing, doc);
    expect(colorsOf(container)).toEqual(["green", "green"]);
  });

  it("degraded snapshot: down primary reads red, live fallback reads amber", () => {
    // Mirrors the canonical degraded case — the color derivation must agree with
    // sourceIndicator so the page tells the operator which host is live.
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderSources(
      container,
      FALLBACK_SNAPSHOT.sources,
      FALLBACK_SNAPSHOT.routing,
      doc,
    );
    expect(colorsOf(container)).toEqual(["red", "amber"]);
  });

  it("total outage: both sources read red", () => {
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderSources(container, DOWN_SNAPSHOT.sources, DOWN_SNAPSHOT.routing, doc);
    expect(colorsOf(container)).toEqual(["red", "red"]);
  });

  it("labels each row with the source id so the operator can tell them apart", () => {
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderSources(container, GREEN_SNAPSHOT.sources, GREEN_SNAPSHOT.routing, doc);
    expect(container.textContent).toContain("p");
    expect(container.textContent).toContain("f");
  });

  it("re-rendering replaces prior rows (no stale accumulation across polls)", () => {
    // The refresh loop re-renders every 15s; a second render must not append to
    // the first, or dead rows from a prior snapshot would linger.
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderSources(container, GREEN_SNAPSHOT.sources, "primary", doc);
    renderSources(container, DOWN_SNAPSHOT.sources, "unreachable", doc);
    expect(colorsOf(container)).toEqual(["red", "red"]);
  });
});

describe("renderConnectors", () => {
  it("renders one link per connector with href=url and text=name", () => {
    // The link target + label come straight from config; a config edit + redeploy
    // is the only way the list changes (no hardcoded connectors).
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    const conns: ConnectorConfig[] = [
      { name: "StoaExplorer", url: "https://explorer.example" },
      { name: "AncientHoldings", url: "https://holdings.example" },
    ];
    renderConnectors(container, conns, doc);
    const links = container.querySelectorAll("a");
    expect(links.map((a) => a.attributes.href)).toEqual([
      "https://explorer.example",
      "https://holdings.example",
    ]);
    expect(links.map((a) => a.textContent)).toContain("StoaExplorer");
  });

  it("renders a logo <img> only for connectors that carry a logo", () => {
    // A connector with a logo gets an <img src=logo>; one without gets none.
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderConnectors(
      container,
      [
        { name: "WithLogo", url: "https://a.example", logo: "https://cdn/a.svg" },
        { name: "NoLogo", url: "https://b.example" },
      ],
      doc,
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.map((i) => i.attributes.src)).toEqual(["https://cdn/a.svg"]);
  });

  it("renders an empty container for an empty connector list (no crash)", () => {
    const doc = makeFakeDocument();
    const container = doc.createElement("div");
    renderConnectors(container, [], doc);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("createRefreshLoop — 15s health poll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires the fetch immediately on start (first snapshot without waiting 15s)", async () => {
    // Mirrors useNodeHealth: the first poll fires on mount so the page shows real
    // state fast instead of grey for a full interval.
    const onSnapshot = vi.fn();
    const fetchSnapshot = vi.fn().mockResolvedValue(GREEN_SNAPSHOT);
    const stop = createRefreshLoop({ fetchSnapshot, onSnapshot, intervalMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(GREEN_SNAPSHOT);
    stop();
  });

  it("fires again on every interval tick (15s cadence)", async () => {
    const onSnapshot = vi.fn();
    const fetchSnapshot = vi.fn().mockResolvedValue(GREEN_SNAPSHOT);
    const stop = createRefreshLoop({ fetchSnapshot, onSnapshot, intervalMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    // 1 immediate + 2 interval fires = 3 total.
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops cleanly — no fetch after the returned stop() clears the interval", async () => {
    // Teardown must clearInterval so a torn-down loop never keeps polling.
    const onSnapshot = vi.fn();
    const fetchSnapshot = vi.fn().mockResolvedValue(GREEN_SNAPSHOT);
    const stop = createRefreshLoop({ fetchSnapshot, onSnapshot, intervalMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });
});
