import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerHealthz } from "./healthz.js";
import type { HealthSnapshot } from "../health/index.js";

function appWith(snapshot: HealthSnapshot): Hono {
  const app = new Hono();
  registerHealthz(app, { resolve: async () => snapshot });
  return app;
}

interface HealthzBody {
  service: string;
  active: { sourceId: string; url: string };
  routing: string;
  sources: { id: string; url: string; role: string; reachable: boolean }[];
}

async function healthzBody(app: Hono): Promise<{ res: Response; body: HealthzBody }> {
  const res = await app.request("/healthz");
  return { res, body: (await res.json()) as HealthzBody };
}

const GREEN: HealthSnapshot = {
  active: { sourceId: "stoachain-primary", url: "https://primary.example" },
  routing: "primary",
  sources: [
    { id: "stoachain-primary", url: "https://primary.example", role: "primary", reachable: true },
    { id: "stoachain-fallback", url: "https://fallback.example", role: "fallback", reachable: true },
  ],
};

const AMBER: HealthSnapshot = {
  active: { sourceId: "stoachain-fallback", url: "https://fallback.example" },
  routing: "fallback",
  sources: [
    { id: "stoachain-primary", url: "https://primary.example", role: "primary", reachable: false },
    { id: "stoachain-fallback", url: "https://fallback.example", role: "fallback", reachable: true },
  ],
};

const RED: HealthSnapshot = {
  active: { sourceId: "stoachain-primary", url: "https://primary.example" },
  routing: "unreachable",
  sources: [
    { id: "stoachain-primary", url: "https://primary.example", role: "primary", reachable: false },
    { id: "stoachain-fallback", url: "https://fallback.example", role: "fallback", reachable: false },
  ],
};

describe("GET /healthz", () => {
  it("reports GREEN backing — routing 'primary', both sources reachable, HTTP 200", async () => {
    const { res, body } = await healthzBody(appWith(GREEN));
    expect(res.status).toBe(200);
    expect(body.service).toBe("ok");
    expect(body.routing).toBe("primary");
    expect(body.active).toEqual({
      sourceId: "stoachain-primary",
      url: "https://primary.example",
    });
    expect(body.sources).toEqual(GREEN.sources);
  });

  it("reports AMBER backing — routing 'fallback', primary unreachable / fallback reachable", async () => {
    const { res, body } = await healthzBody(appWith(AMBER));
    expect(res.status).toBe(200);
    expect(body.routing).toBe("fallback");
    expect(body.sources.find((s) => s.role === "primary")?.reachable).toBe(false);
    expect(body.sources.find((s) => s.role === "fallback")?.reachable).toBe(true);
  });

  it("stays HTTP 200 with service:'ok' even when routing is 'unreachable' (service liveness != source health)", async () => {
    // The process answering IS the liveness proof — source health is body-only.
    const { res, body } = await healthzBody(appWith(RED));
    expect(res.status).toBe(200);
    expect(body.service).toBe("ok");
    expect(body.routing).toBe("unreachable");
    expect(body.sources.every((s) => s.reachable === false)).toBe(true);
  });

  it("distinguishes all three states — the three scenarios yield three distinct routing values and reachability tuples", async () => {
    const { body: green } = await healthzBody(appWith(GREEN));
    const { body: amber } = await healthzBody(appWith(AMBER));
    const { body: red } = await healthzBody(appWith(RED));

    const routings = [green.routing, amber.routing, red.routing];
    expect(new Set(routings).size).toBe(3);
    expect(routings).toEqual(["primary", "fallback", "unreachable"]);

    const tuple = (b: HealthzBody) =>
      b.sources.map((s) => s.reachable).join(",");
    const tuples = new Set([tuple(green), tuple(amber), tuple(red)]);
    expect(tuples.size).toBe(3);
  });
});
