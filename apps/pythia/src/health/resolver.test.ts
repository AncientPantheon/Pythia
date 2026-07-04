import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveHealth, startHealthPoller } from "./resolver.js";
import type { SourceConfig } from "../config/index.js";

const primary: SourceConfig = {
  id: "stoachain-primary",
  url: "https://primary.example",
  role: "primary",
  chain: "stoa",
};
const fallback: SourceConfig = {
  id: "stoachain-fallback",
  url: "https://fallback.example",
  role: "fallback",
  chain: "stoa",
};

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}

describe("resolveHealth (three-state active-routing resolution)", () => {
  it("resolves GREEN — routing 'primary', active=primary — when the primary /info is ok", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toMatch(/\/info$/);
      return okResponse();
    });

    const snap = await resolveHealth({ primary, fallback, fetchImpl });

    expect(snap.routing).toBe("primary");
    expect(snap.active).toEqual({
      sourceId: "stoachain-primary",
      url: "https://primary.example",
    });
    expect(snap.sources.find((s) => s.role === "primary")?.reachable).toBe(true);
  });

  it("resolves AMBER — routing 'fallback', active=fallback — when primary /info fails but fallback /info is ok", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.example")) throw new TypeError("down");
      return okResponse();
    });

    const snap = await resolveHealth({ primary, fallback, fetchImpl });

    expect(snap.routing).toBe("fallback");
    expect(snap.active).toEqual({
      sourceId: "stoachain-fallback",
      url: "https://fallback.example",
    });
    expect(snap.sources.find((s) => s.role === "primary")?.reachable).toBe(false);
    expect(snap.sources.find((s) => s.role === "fallback")?.reachable).toBe(true);
  });

  it("resolves RED — routing 'unreachable' — when neither /info is ok", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("down");
    });

    const snap = await resolveHealth({ primary, fallback, fetchImpl });

    expect(snap.routing).toBe("unreachable");
    expect(snap.sources.every((s) => s.reachable === false)).toBe(true);
  });

  it("treats a non-2xx /info response as unreachable (res.ok gate, mirroring useNodeHealth)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const snap = await resolveHealth({ primary, fallback, fetchImpl });
    expect(snap.routing).toBe("unreachable");
  });
});

describe("resolveHealth timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts a hung /info after the per-check timeout and counts it unreachable", async () => {
    // The primary /info never settles until aborted; the fallback answers ok.
    const fetchImpl = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (url.startsWith("https://fallback.example")) {
            resolve(okResponse());
            return;
          }
          const signal = init?.signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const promise = resolveHealth({
      primary,
      fallback,
      fetchImpl,
      timeoutMs: 3000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    const snap = await promise;

    expect(snap.sources.find((s) => s.role === "primary")?.reachable).toBe(false);
    expect(snap.routing).toBe("fallback");
  });
});

describe("startHealthPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires immediately on start, then again after one interval", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const onSnapshot = vi.fn();

    const stop = startHealthPoller(
      { primary, fallback, fetchImpl },
      { intervalMs: 15_000, onSnapshot },
    );

    // Immediate poll on start.
    await vi.advanceTimersByTimeAsync(0);
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    // One interval later → a second resolution.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);

    expect(onSnapshot.mock.calls[0][0].routing).toBe("primary");
    stop();
  });
});
