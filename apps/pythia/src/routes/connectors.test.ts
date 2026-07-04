import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerConnectors } from "./connectors.js";
import type { PythiaConfig, ConnectorConfig } from "../config/index.js";

function configWith(connectors: ConnectorConfig[]): PythiaConfig {
  return {
    sources: [
      { id: "p", url: "https://p.example", role: "primary", chain: "stoachain" },
      { id: "f", url: "https://f.example", role: "fallback", chain: "stoachain" },
    ],
    connectors,
    finalityDepth: 6,
    corsOrigins: [],
  };
}

function appWith(connectors: ConnectorConfig[]): Hono {
  const app = new Hono();
  registerConnectors(app, { loadConfig: () => configWith(connectors) });
  return app;
}

interface ConnectorsBody {
  connectors: ConnectorConfig[];
}

async function fetchConnectors(app: Hono): Promise<{ res: Response; body: ConnectorsBody }> {
  const res = await app.request("/api/v1/connectors");
  return { res, body: (await res.json()) as ConnectorsBody };
}

describe("GET /api/v1/connectors", () => {
  it("returns HTTP 200 with a { connectors: [...] } envelope", async () => {
    // The page fetches this once at load; a wrapped object (not a bare array)
    // keeps the envelope forward-compatible, matching /healthz's keyed shape.
    const { res, body } = await fetchConnectors(appWith([]));
    expect(res.status).toBe(200);
    expect(Array.isArray(body.connectors)).toBe(true);
    expect(body.connectors).toEqual([]);
  });

  it("passes a connector's name and url through verbatim from config", async () => {
    // The rendered link's href + text come straight from config — the endpoint
    // must not rewrite or drop them, or the page would link to the wrong place.
    const conn: ConnectorConfig = {
      name: "StoaExplorer",
      url: "https://explorer.stoachain.com",
    };
    const { body } = await fetchConnectors(appWith([conn]));
    expect(body.connectors).toEqual([conn]);
  });

  it("includes the optional logo field when present in config", async () => {
    // A connector with a logo must surface it so the page can render an <img>.
    const conn: ConnectorConfig = {
      name: "AncientHoldings",
      url: "https://ancientholdings.eu",
      logo: "https://cdn.example/logo.svg",
    };
    const { body } = await fetchConnectors(appWith([conn]));
    expect(body.connectors[0].logo).toBe("https://cdn.example/logo.svg");
  });

  it("omits the logo key entirely when absent in config", async () => {
    // logo is optional; a connector without one must not carry a logo key at all
    // (not logo:null/undefined), so the client can test presence with `in`/truthiness.
    const conn: ConnectorConfig = { name: "Plain", url: "https://plain.example" };
    const { body } = await fetchConnectors(appWith([conn]));
    expect("logo" in body.connectors[0]).toBe(false);
  });

  it("carries ONLY the connector fields (no sources / finalityDepth leak)", async () => {
    // The read-only connector endpoint must expose the connector list only —
    // not the source hosts or finality config, which belong to /healthz and reads.
    const { body } = await fetchConnectors(
      appWith([{ name: "A", url: "https://a.example" }]),
    );
    expect(Object.keys(body)).toEqual(["connectors"]);
  });

  it("preserves connector order from config", async () => {
    // The page renders the list in config order; a reorder in config must be the
    // only way the displayed order changes.
    const conns: ConnectorConfig[] = [
      { name: "First", url: "https://1.example" },
      { name: "Second", url: "https://2.example" },
      { name: "Third", url: "https://3.example" },
    ];
    const { body } = await fetchConnectors(appWith(conns));
    expect(body.connectors.map((c) => c.name)).toEqual(["First", "Second", "Third"]);
  });
});
