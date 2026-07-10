import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { postForm, createAdminGate } from "./routes.js";
import { signSession } from "./session.js";
import type { OidcConfig } from "./oidcConfig.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAdminGate — duplicate-cookie tolerance", () => {
  const secret = "unit-test-session-secret-at-least-32-chars";
  const gate = createAdminGate({ sessionSecret: secret } as OidcConfig);
  const app = new Hono();
  app.get("/admin/thing", gate, (c) => c.json({ ok: true }));

  it("admits when a VALID session cookie trails a stale duplicate of the same name", async () => {
    // The exact production failure: a legacy path=/admin cookie is sent FIRST
    // (longer path, per RFC 6265), the valid path=/ session SECOND. getCookie
    // would pick the stale first one and 401; the gate must scan both and admit.
    const valid = await signSession(
      { sub: "u1", roles: ["ancient"], name: "Ancient" },
      secret,
    );
    const cookie = `pythia_admin_session=STALE.INVALID.TOKEN; pythia_admin_session=${valid}`;
    const res = await app.request("/admin/thing", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s when only a stale/invalid cookie is present", async () => {
    const res = await app.request("/admin/thing", {
      headers: { cookie: "pythia_admin_session=STALE.INVALID.TOKEN" },
    });
    expect(res.status).toBe(401);
  });

  it("401s when no session cookie is present at all", async () => {
    const res = await app.request("/admin/thing");
    expect(res.status).toBe(401);
  });

  it("403s when a valid session lacks the ancient role", async () => {
    const modern = await signSession(
      { sub: "u2", roles: ["modern"], name: "Modern" },
      secret,
    );
    const res = await app.request("/admin/thing", {
      headers: { cookie: `pythia_admin_session=${modern}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("postForm — token-exchange redirect handling", () => {
  it("follows a 308 trailing-slash redirect, preserving method, body, and auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        // The hub's Next.js trailingSlash 308.
        return new Response(null, {
          status: 308,
          headers: { location: "/api/oidc/token/" },
        });
      }
      return new Response(JSON.stringify({ id_token: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await postForm(
      "https://hub.example/api/oidc/token",
      { authorization: "Basic abc", "content-type": "application/x-www-form-urlencoded" },
      "grant_type=authorization_code&code=real",
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // The retry resolves the relative Location against the original origin...
    expect(calls[1].url).toBe("https://hub.example/api/oidc/token/");
    // ...and carries the method, body, and Authorization the auto-follow would drop.
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.body).toBe("grant_type=authorization_code&code=real");
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Basic abc");
  });

  it("returns the response directly when there is no redirect", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postForm("https://hub.example/api/oidc/token/", {}, "body");
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
