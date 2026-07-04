import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "./cors.js";

/** A minimal app that mounts the CORS middleware ahead of one JSON route. */
function appWith(corsOrigins?: string[]): Hono {
  const app = new Hono();
  app.use("*", corsMiddleware(corsOrigins));
  app.get("/api/v1/ping", (c) => c.json({ ok: true }));
  app.post("/stoachain/rpc", (c) => c.json({ ok: true }));
  return app;
}

describe("corsMiddleware", () => {
  it("stamps a wildcard allow-origin on API responses when no origins are configured", async () => {
    // A browser calling the read-only gateway cross-origin must receive an
    // allow-origin header or the fetch is blocked; the permissive default is "*".
    const app = appWith();

    const res = await app.request("/api/v1/ping", {
      headers: { origin: "https://ouronet.ui" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers a preflight OPTIONS with allow-origin, allowed methods, and allowed headers", async () => {
    // The browser sends an OPTIONS preflight for a POST relay call; without the
    // right preflight headers the actual POST is never made.
    const app = appWith();

    const res = await app.request("/stoachain/rpc", {
      method: "OPTIONS",
      headers: {
        origin: "https://ouronet.ui",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    // Hono's cors returns 204 for a handled preflight.
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowMethods).toContain("GET");
    expect(allowMethods).toContain("POST");
    expect(allowMethods).toContain("OPTIONS");
    const allowHeaders = (
      res.headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();
    expect(allowHeaders).toContain("content-type");
  });

  it("honors a configured allowlist — echoes an allowed origin and withholds allow-origin for a disallowed one", async () => {
    // When the operator pins corsOrigins, only those origins may read: an
    // allowed origin is echoed back, a stranger gets no allow-origin header.
    const app = appWith(["https://ouronet.ui", "https://wallet.stoachain.com"]);

    const allowed = await app.request("/api/v1/ping", {
      headers: { origin: "https://ouronet.ui" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://ouronet.ui",
    );

    const stranger = await app.request("/api/v1/ping", {
      headers: { origin: "https://evil.example" },
    });
    expect(stranger.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example",
    );
  });

  it("falls back to wildcard when configured with an empty allowlist", async () => {
    // An empty array is treated as "unset" so a mis-typed config never silently
    // locks every browser out of the public read gateway.
    const app = appWith([]);

    const res = await app.request("/api/v1/ping", {
      headers: { origin: "https://anything.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
