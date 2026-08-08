import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { effectiveKey, isFirstParty, firstPartyKeyMiddleware, INJECTED_KEY_VAR } from "./effectiveKey.js";

const MARKER = "fp_test_marker";

/** Mount the injection middleware, then echo the resolved effective key so a test
 * can assert what the gate/meters would attribute the request by. */
function echoApp(selfSecret: string | null): Hono {
  const app = new Hono();
  app.use("*", firstPartyKeyMiddleware(() => selfSecret, MARKER));
  app.post("/stoachain/read", (c) => c.json({ key: effectiveKey(c) ?? null }));
  app.get("/api/me", (c) => c.json({ key: effectiveKey(c) ?? null }));
  return app;
}

describe("effectiveKey + firstPartyKeyMiddleware", () => {
  it("prefers an explicit x-pythia-key header over any injected key", async () => {
    const res = await echoApp("SELF").request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": "pk_real", "sec-fetch-site": "same-origin" },
    });
    expect(await res.json()).toEqual({ key: "pk_real" });
  });

  it("injects the self secret for a same-origin keyless operational read", async () => {
    const res = await echoApp("SELF").request("/stoachain/read", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(await res.json()).toEqual({ key: "SELF" });
  });

  it("does NOT inject for a cross-site keyless read (no self, stays undefined)", async () => {
    const res = await echoApp("SELF").request("/stoachain/read", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(await res.json()).toEqual({ key: null });
  });

  it("does NOT inject on a NON-operational path even if same-origin", async () => {
    const res = await echoApp("SELF").request("/api/me", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(await res.json()).toEqual({ key: null });
  });

  it("injects the MARKER (not null) for a same-origin keyless read when NO self secret is active", async () => {
    // Robustness: Pythia's own site must stay readable in the windows her self secret
    // is briefly absent (e.g. just after a deploy). The marker resolves to pythia-self.
    const res = await echoApp(null).request("/stoachain/read", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(await res.json()).toEqual({ key: MARKER });
  });

  it("isFirstParty is true only for Sec-Fetch-Site: same-origin", () => {
    const mk = (site?: string) =>
      ({ req: { header: (h: string) => (h === "sec-fetch-site" ? site : undefined) } }) as never;
    expect(isFirstParty(mk("same-origin"))).toBe(true);
    expect(isFirstParty(mk("same-site"))).toBe(false);
    expect(isFirstParty(mk("cross-site"))).toBe(false);
    expect(isFirstParty(mk(undefined))).toBe(false);
  });

  it("exports a stable context-var name", () => {
    expect(INJECTED_KEY_VAR).toBe("pythiaKey");
  });
});
