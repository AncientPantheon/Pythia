import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
// TEST-ONLY cross-workspace source imports of the private gateway service. These
// exercise a REAL client -> in-process service round-trip. They are NOT runtime
// SDK dependencies: `tests/**` is excluded from `tsconfig.build.json`, so none of
// this lands in the published `dist` and the shipped client stays dependency-free.
import { registerHealthz } from "../../../apps/pythia/src/routes/healthz.js";
import { registerRead } from "../../../apps/pythia/src/routes/read.js";
import { registerSend } from "../../../apps/pythia/src/routes/send.js";
import { registerPoll } from "../../../apps/pythia/src/routes/poll.js";
import { resolveHealth } from "../../../apps/pythia/src/health/index.js";
import type { SourceConfig } from "../../../apps/pythia/src/config/index.js";
import {
  PythiaClient,
  PythiaPoolExhaustedError,
  type HealthSnapshot,
  type PollResult,
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

/**
 * Build a fresh, hermetic gateway app with an injected stubbed upstream. The
 * `/info` liveness ping and the chainweb transport reads are canned so no live
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
  registerRead(app, { sources, fetchImpl: fetchImpl as never });
  registerSend(app, { sources, fetchImpl: fetchImpl as never });
  registerPoll(app, {
    sources,
    fetchImpl: fetchImpl as never,
    finalityDepth: 6,
  });
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

function nodeJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PythiaClient e2e over the in-process gateway", () => {
  it("client.health() returns a typed HealthSnapshot (service:'ok') from the round-trip", async () => {
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

  it("client.read() relays the built /local command and returns the node body verbatim", async () => {
    // The node echoes a success envelope; the client returns it undecoded.
    const nodeBody = { result: { status: "success", data: 42 } };
    const app = buildApp((url, init) => {
      // The read route must build a {cmd,hash,sigs} /local envelope.
      const body = JSON.parse(String(init?.body)) as { cmd: string; hash: string };
      expect(typeof body.cmd).toBe("string");
      expect(typeof body.hash).toBe("string");
      expect(url.endsWith("/pact/api/v1/local")).toBe(true);
      return nodeJson(nodeBody);
    });
    const client = buildClient(app);

    const result = await client.read({ code: "(+ 40 2)" });
    expect(result).toEqual(nodeBody);
  });

  it("client.send() relays {cmds} verbatim to /send and returns the node response", async () => {
    const cmds = [{ cmd: "{}", hash: "h", sigs: [{ sig: "caller-sig" }] }];
    const app = buildApp((url, init) => {
      expect(url.endsWith("/pact/api/v1/send")).toBe(true);
      // Keyless: the body is exactly {cmds} with the caller's own sig intact.
      expect(JSON.parse(String(init?.body))).toEqual({ cmds });
      return nodeJson({ requestKeys: ["rk-1"] });
    });
    const client = buildClient(app);

    const result = await client.send({ cmds });
    expect(result).toEqual({ requestKeys: ["rk-1"] });
  });

  it("client.poll() returns per-request-key status/depth from the poll+cut round-trip", async () => {
    const app = buildApp((url) => {
      if (url.endsWith("/cut")) {
        return nodeJson({ hashes: { "0": { height: 110, hash: "h" } } });
      }
      // /poll — key mined at height 100 → depth 10 → final at finalityDepth 6.
      return nodeJson({ "rk-a": { reqKey: "rk-a", blockHeight: 100 } });
    });
    const client = buildClient(app);

    const result: PollResult = await client.poll({ requestKeys: ["rk-a"] });
    expect(result.finalityDepth).toBe(6);
    expect(result.results["rk-a"]).toEqual({
      status: "final",
      depth: 10,
      blockHeight: 100,
    });
  });

  it("surfaces PythiaPoolExhaustedError when both upstream hosts fail transport", async () => {
    const app = buildApp(() => {
      throw new TypeError("all hosts down");
    });
    const client = buildClient(app);

    const err = await client.read({ code: "(f)" }).catch((e) => e);

    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
    expect((err as PythiaPoolExhaustedError).failures.length).toBeGreaterThan(0);
  });
});
