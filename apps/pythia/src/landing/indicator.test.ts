import { describe, it, expect } from "vitest";
import { sourceIndicator, pendingIndicator } from "./indicator.js";
import type { SourceHealth, Routing } from "../health/index.js";

const primary: SourceHealth = {
  id: "stoachain-primary",
  url: "https://primary.example",
  role: "primary",
  reachable: true,
};
const fallback: SourceHealth = {
  id: "stoachain-fallback",
  url: "https://fallback.example",
  role: "fallback",
  reachable: true,
};

function withReachable(s: SourceHealth, reachable: boolean): SourceHealth {
  return { ...s, reachable };
}

describe("sourceIndicator — health -> color mapping", () => {
  it("paints the reachable primary GREEN when routing is 'primary' (nominal)", () => {
    // GREEN means: this source is the live primary the service is routing to.
    // If the mapping ever downgraded a nominal primary, users would see false
    // degradation. Drives off routing='primary' + reachable primary role.
    const routing: Routing = "primary";
    expect(sourceIndicator(primary, routing)).toBe("green");
  });

  it("paints the live fallback AMBER when routing is 'fallback' (degraded)", () => {
    // AMBER means: primary is down and the service fell through to this fallback.
    // Distinguishes a degraded-but-serving state from a nominal one.
    const routing: Routing = "fallback";
    expect(sourceIndicator(fallback, routing)).toBe("amber");
  });

  it("paints any unreachable source RED regardless of routing", () => {
    // RED is reachability-driven: a source that failed its /info ping is red
    // whether routing is primary, fallback, or unreachable.
    expect(sourceIndicator(withReachable(primary, false), "fallback")).toBe("red");
    expect(sourceIndicator(withReachable(primary, false), "unreachable")).toBe("red");
    expect(sourceIndicator(withReachable(fallback, false), "primary")).toBe("red");
  });

  it("mixed case: primary down + fallback up -> primary RED, fallback AMBER", () => {
    // The canonical degraded snapshot. The down primary must read red (not green)
    // and the serving fallback must read amber (not green), so the page tells the
    // operator exactly which host is live.
    const routing: Routing = "fallback";
    const downPrimary = withReachable(primary, false);
    expect(sourceIndicator(downPrimary, routing)).toBe("red");
    expect(sourceIndicator(fallback, routing)).toBe("amber");
  });

  it("both down -> both sources RED (routing 'unreachable')", () => {
    // Total outage: neither host answered, so both dots are red — no false amber.
    const routing: Routing = "unreachable";
    expect(sourceIndicator(withReachable(primary, false), routing)).toBe("red");
    expect(sourceIndicator(withReachable(fallback, false), routing)).toBe("red");
  });

  it("does NOT paint a reachable fallback amber while routing is 'primary'", () => {
    // When primary is nominal, the fallback is reachable-but-idle. It is not the
    // live route, so it must not read amber (which means 'currently serving').
    // A reachable non-serving source reads green (healthy, standing by).
    expect(sourceIndicator(fallback, "primary")).toBe("green");
  });
});

describe("pendingIndicator — pre-first-poll state", () => {
  it("returns grey while no health snapshot has arrived yet (avoids red flash)", () => {
    // Mirrors the badge's isAlive===null grey: before the first /healthz lands we
    // must not flash red, which would look like an outage on every page load.
    expect(pendingIndicator()).toBe("grey");
  });
});
