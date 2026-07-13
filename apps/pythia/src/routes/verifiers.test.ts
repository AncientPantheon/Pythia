import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { VerifierStore } from "../verifiers/store.js";
import { registerVerifiers } from "./verifiers.js";

describe("GET /api/verifiers", () => {
  it("returns only enabled verifiers in the public shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pythia-verifiers-route-"));
    const store = new VerifierStore({ filePath: join(dir, "v.json") });
    store.add({ label: "Mnemosyne", baseUrl: "https://codex.ancientholdings.eu" });
    const off = store.add({ label: "old", baseUrl: "https://old.test" });
    store.setEnabled(off.ok ? off.verifier.id : "", false);

    const app = new Hono();
    registerVerifiers(app, { store });

    const res = await app.request("/api/verifiers");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { verifiers: { label: string; baseUrl: string }[] };
    expect(body.verifiers.map((v) => v.label)).toEqual(["Mnemosyne"]); // the disabled one is hidden
    expect(body.verifiers[0]).not.toHaveProperty("enabled");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list when no verifiers are configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pythia-verifiers-empty-"));
    const app = new Hono();
    registerVerifiers(app, { store: new VerifierStore({ filePath: join(dir, "v.json") }) });
    const body = (await (await app.request("/api/verifiers")).json()) as { verifiers: unknown[] };
    expect(body.verifiers).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
