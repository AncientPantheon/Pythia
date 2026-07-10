import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { NodePool } from "../pool/nodePool.js";
import { TxSenderStore } from "../txsenders/store.js";
import { registerPools } from "./pools.js";

function seededSenders(): { store: TxSenderStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pythia-pools-"));
  const store = new TxSenderStore({
    filePath: join(dir, "txsenders.json"),
    seeds: [
      { url: "https://node1.stoachain.com", label: "node1" },
      { url: "https://node2.stoachain.com", label: "node2" },
    ],
  });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function appWith(pool: NodePool, txSenders: TxSenderStore): Hono {
  const app = new Hono();
  registerPools(app, { pool, txSenders });
  return app;
}

interface PoolsBody {
  observation: { configured: boolean; ok: boolean; count: number };
  upload: { count: number; seeds: { label: string; url: string; enabled: boolean }[] };
}

describe("GET /api/pools", () => {
  it("reports the feed off and the two seed nodes when nothing is configured", async () => {
    // Fresh deploy: no hub client → Observation Pool off; the Upload Pool holds
    // exactly the two baked-in seed nodes, both enabled.
    const { store, cleanup } = seededSenders();
    const pool = new NodePool({ client: null, uploadNodes: () => store.enabledNodes() });

    const res = await appWith(pool, store).request("/api/pools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PoolsBody;

    expect(body.observation).toEqual({ configured: false, ok: false, count: 0 });
    expect(body.upload.count).toBe(2);
    expect(body.upload.seeds.map((s) => s.url)).toEqual([
      "https://node1.stoachain.com",
      "https://node2.stoachain.com",
    ]);
    expect(body.upload.seeds.every((s) => s.enabled)).toBe(true);
    cleanup();
  });

  it("counts admin senders in the Upload total but exposes only seeds' URLs", async () => {
    // An admin-added sender bumps the enabled count to 3, but the seeds array
    // still lists only the two public seed nodes — private URLs never leak.
    const { store, cleanup } = seededSenders();
    store.add({ url: "https://10.0.0.9:1848", label: "private-1" });
    const pool = new NodePool({ client: null, uploadNodes: () => store.enabledNodes() });

    const body = (await (await appWith(pool, store).request("/api/pools")).json()) as PoolsBody;

    expect(body.upload.count).toBe(3);
    expect(body.upload.seeds).toHaveLength(2);
    expect(body.upload.seeds.some((s) => s.url.includes("10.0.0.9"))).toBe(false);
    cleanup();
  });
});
