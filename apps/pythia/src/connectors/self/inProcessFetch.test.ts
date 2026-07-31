import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createInProcessFetch } from "./inProcessFetch.js";

describe("createInProcessFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches through the app's real router, not a stub", async () => {
    const app = new Hono();
    app.get("/ping", (c) => c.json({ ok: true }));

    const inProcessFetch = createInProcessFetch(app);
    const res = await inProcessFetch("/ping");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("never invokes the real global fetch — no socket/DNS/TLS hop", async () => {
    const app = new Hono();
    app.get("/ping", (c) => c.json({ ok: true }));
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");

    const inProcessFetch = createInProcessFetch(app);
    await inProcessFetch("/ping");

    expect(globalFetchSpy).not.toHaveBeenCalled();
  });
});
