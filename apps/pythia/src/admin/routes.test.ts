import { describe, it, expect, vi, afterEach } from "vitest";
import { postForm } from "./routes.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
