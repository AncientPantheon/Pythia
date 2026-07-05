import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";

// Smoke coverage for the additive wiring in src/index.ts: the static landing
// mount at `/` and the connectors route must both respond, and the pre-existing
// API/health routes must remain reachable (the static catch-all must not shadow them).

describe("landing wiring in the app", () => {
  it("serves the landing index.html at GET / (HTML, not JSON)", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
    const html = await res.text();
    // Pins that it is the Pythia landing shell, not an arbitrary 200. The shell
    // is the modular per-chain layout, so it carries the Chains section anchor
    // (the old flat `id="sources"` list was refactored into per-chain modules).
    expect(html).toContain("<title>Pythia");
    expect(html).toContain('id="chains"');
  });

  it("serves the static app.js asset (the client script resolves)", async () => {
    const res = await app.request("/app.js");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("createRefreshLoop");
  });

  it("responds to GET /api/v1/connectors with the { connectors } envelope", async () => {
    const res = await app.request("/api/v1/connectors");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: unknown[] };
    expect(Array.isArray(body.connectors)).toBe(true);
  });

  it("does NOT let the static mount shadow /healthz (API still reachable)", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; routing: string };
    expect(body.service).toBe("ok");
    expect(["primary", "fallback", "unreachable"]).toContain(body.routing);
  });

  it("keeps the read relay reachable — POST /stoachain/read is not shadowed", async () => {
    // An out-of-range chainId is rejected with 400 BEFORE any network attempt,
    // proving the read route handler ran — the static `/` catch-all did not shadow
    // it (a shadow would yield a 404 from static file resolution, not a 400).
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: 99, code: "(f)" }),
    });
    expect(res.status).toBe(400);
  });
});
