import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
// TEST-ONLY cross-workspace source imports of the private gateway service. These
// exercise a REAL client -> in-process service round-trip. They are NOT runtime
// SDK dependencies: `tests/**` is excluded from `tsconfig.build.json`, so none of
// this lands in the published `dist` and the shipped client stays dependency-free.
import { registerHealthz } from "../../../apps/pythia/src/routes/healthz.js";
import { registerRpc } from "../../../apps/pythia/src/routes/rpc.js";
import { registerGetBalance } from "../../../apps/pythia/src/routes/getBalance.js";
import { registerGetConfirmations } from "../../../apps/pythia/src/routes/getConfirmations.js";
import { resolveHealth } from "../../../apps/pythia/src/health/index.js";
import type { SourceConfig } from "../../../apps/pythia/src/config/index.js";
import {
  PythiaClient,
  PythiaPoolExhaustedError,
  type HealthSnapshot,
  type Balance,
} from "../src/index.js";

const primary: SourceConfig = {
  id: "stoachain-primary",
  url: "https://primary.example",
  role: "primary",
  chain: "stoachain",
};
const fallback: SourceConfig = {
  id: "stoachain-fallback",
  url: "https://fallback.example",
  role: "fallback",
  chain: "stoachain",
};
const sources = { primary, fallback };

/** A chainweb /local success envelope carrying a Pact decimal result (Phase-3
 * mock shape). */
function localOk(decimal: string): Response {
  return new Response(
    JSON.stringify({ result: { status: "success", data: { decimal } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Build a fresh, hermetic gateway app with an injected stubbed upstream. The
 * `/info` liveness ping and the chainweb `/local` reads are canned so no live
 * node (and no disk config) is touched. The client's own `fetchImpl` delegates
 * to `app.request` so the round-trip is real client -> in-process HTTP.
 */
function buildApp(upstream: (url: string, init?: RequestInit) => Response) {
  const app = new Hono();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
    upstream(url, init),
  );
  registerHealthz(app, {
    resolve: () =>
      resolveHealth({ primary, fallback, fetchImpl: fetchImpl as never }),
  });
  registerRpc(app, { sources, fetchImpl: fetchImpl as never });
  registerGetBalance(app, { sources, fetchImpl: fetchImpl as never });
  registerGetConfirmations(app, { sources, fetchImpl: fetchImpl as never });
  return app;
}

/** Build a client whose transport routes to the in-process Hono app. */
function buildClient(app: Hono): PythiaClient {
  return new PythiaClient({
    baseUrl: "http://in-process",
    fetchImpl: ((url: string, init?: RequestInit) =>
      app.request(url, init)) as never,
  });
}

describe("PythiaClient e2e over the in-process gateway", () => {
  it("client.health() returns a typed HealthSnapshot (service:'ok') from the round-trip", async () => {
    // Both hosts answer /info -> routing resolves to the primary.
    const app = buildApp((url) => {
      if (url.endsWith("/info")) return new Response("{}", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const client = buildClient(app);

    const health: HealthSnapshot = await client.health();

    expect(health.service).toBe("ok");
    expect(health.routing).toBe("primary");
    expect(health.active.sourceId).toBe("stoachain-primary");
    expect(health.sources.map((s) => s.reachable)).toEqual([true, true]);
  });

  it("client.getBalance() decodes a typed Balance from the stubbed upstream", async () => {
    // Route each /local read to a supply keyed by the Pact module the body names
    // (Phase-3 mock shape) so the composite decodes field-by-field.
    const app = buildApp((_url, init) => {
      const body = String(init?.body);
      if (body.includes("DALOS.UR_DISPOSupply")) return localOk("12.5");
      if (body.includes("TFT.URC_VirtualOuro")) return localOk("3.25");
      if (body.includes("GAS-8Nh-JO8JO4F5")) return localOk("0.001");
      return localOk("0");
    });
    const client = buildClient(app);

    const balance: Balance = await client.getBalance({ address: "k:abc123" });

    expect(balance).toEqual({
      chain: "stoachain",
      address: "k:abc123",
      ignis: "0.001",
      ouroDispo: "12.5",
      virtualOuro: "3.25",
    });
  });

  it("surfaces PythiaPoolExhaustedError when both upstream hosts fail transport", async () => {
    // Every host throws -> the dial exhausts the pool -> the service answers 502
    // -> the client maps it to the typed PythiaPoolExhaustedError.
    const app = buildApp(() => {
      throw new TypeError("all hosts down");
    });
    const client = buildClient(app);

    const err = await client
      .getBalance({ address: "k:abc123" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
    expect((err as PythiaPoolExhaustedError).failures.length).toBeGreaterThan(0);
  });
});
