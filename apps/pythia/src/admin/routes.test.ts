import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { postForm, createAdminGate, registerAdmin } from "./routes.js";
import { signSession } from "./session.js";
import { ConnectorStore } from "../connectors/store.js";
import type { OidcConfig } from "./oidcConfig.js";
import type { SelfConnectorStatus, SelfConnectorHalfView } from "./routes.js";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { SelfApolloVault } from "../automaton/selfApollo.js";
import { SelfConnectorLoop } from "../automaton/selfConnectorLoop.js";
import type { SelfConnectorHalfStatus } from "../automaton/selfConnectorLoop.js";
import { createInProcessFetch } from "../connectors/self/inProcessFetch.js";
import { maskSecret, DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";

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

describe("admin /admin/self-connector[/generate] — SelfConnectorAdminControls extra", () => {
  const SECRET = "unit-test-session-secret-at-least-32-chars";
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), "pyth-selfconn-"));
    tmpDirs.push(d);
    return d;
  }

  const FIXTURE: SelfConnectorStatus = {
    standardAccount: "k:standard-account",
    smartAccount: "w:smart-account",
    dualLinkKey: "fixture-dual-link-key",
    standard: { state: "active", maskedSecret: "pk_eph_...abcdefg", expiresAt: 1_700_000_000_000 },
    smart: { state: "pending", maskedSecret: null, expiresAt: null },
  };

  function makeApp(withSelfConnector: boolean) {
    const app = new Hono();
    const dir = scratch();
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      withSelfConnector
        ? {
            selfConnector: {
              status: vi.fn(async () => ({ ...FIXTURE })),
              generate: vi.fn(async () => ({ ...FIXTURE })),
              link: vi.fn(async () => ({ ...FIXTURE })),
            },
          }
        : {},
    );
    return app;
  }

  async function ancientCookie(): Promise<string> {
    const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
    return `pythia_admin_session=${t}`;
  }

  it("GET /admin/self-connector 404s when the selfConnector extra is not wired", async () => {
    const res = await makeApp(false).request("/admin/self-connector", {
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(404);
  });

  it("GET /admin/self-connector returns the fake's status() as JSON for an ancient", async () => {
    const res = await makeApp(true).request("/admin/self-connector", {
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FIXTURE);
  });

  it("POST /admin/self-connector/generate calls the fake's generate() and returns its result", async () => {
    const res = await makeApp(true).request("/admin/self-connector/generate", {
      method: "POST",
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FIXTURE);
  });

  it("401s both routes when unauthenticated", async () => {
    const app = makeApp(true);
    expect((await app.request("/admin/self-connector")).status).toBe(401);
    expect(
      (await app.request("/admin/self-connector/generate", { method: "POST" })).status,
    ).toBe(401);
  });

  it("POST /admin/self-connector/link calls the fake's link() with the posted dualLinkKey and returns its result", async () => {
    const app = new Hono();
    const dir = scratch();
    const linkMock = vi.fn(async () => ({ ...FIXTURE }));
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      {
        selfConnector: {
          status: vi.fn(async () => ({ ...FIXTURE })),
          generate: vi.fn(async () => ({ ...FIXTURE })),
          link: linkMock,
        },
      },
    );
    const res = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey: "posted-dual-link-key" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FIXTURE);
    expect(linkMock).toHaveBeenCalledTimes(1);
    expect(linkMock).toHaveBeenCalledWith("posted-dual-link-key");
  });

  it("POST /admin/self-connector/link 401s when unauthenticated", async () => {
    const app = makeApp(true);
    const res = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey: "posted-dual-link-key" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /admin/self-connector/link surfaces the fake's thrown message as a 400", async () => {
    const app = new Hono();
    const dir = scratch();
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      {
        selfConnector: {
          status: vi.fn(async () => ({ ...FIXTURE })),
          generate: vi.fn(async () => ({ ...FIXTURE })),
          link: vi.fn(async () => {
            throw new Error("some validation message");
          }),
        },
      },
    );
    const res = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey: "posted-dual-link-key" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "some validation message" });
  });
});

describe("admin /admin/self-connector[/generate] — REAL SelfApolloVault + SelfConnectorLoop wiring", () => {
  // The T4 suite above proves the route contract against a FAKE
  // SelfConnectorAdminControls; this proves the composition-root's own
  // status()/generate() shape (mirrored here — index.ts itself has no
  // test-import surface, see selfConnectorIntegration.test.ts's doc comment)
  // actually round-trips when driven by REAL SelfApolloVault/SelfConnectorLoop
  // instances: not-generated before generation, populated + pending after.
  const SECRET = "unit-test-session-secret-at-least-32-chars";
  const MASTER_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    await ensureSodiumReady();
  });
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), "pyth-selfconn-real-"));
    tmpDirs.push(d);
    return d;
  }

  async function ancientCookie(): Promise<string> {
    const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
    return `pythia_admin_session=${t}`;
  }

  // Maps a loop half-status onto the admin view shape — mirrors, on purpose,
  // the exact closure T5 wires into the real `index.ts` composition root (see
  // that task's doc comment): `maskSecret`-ing the secret when active, nulls
  // otherwise, state copied through 1:1.
  function toHalfView(half: SelfConnectorHalfStatus): SelfConnectorHalfView {
    if (half.status === "active") {
      return { state: "active", maskedSecret: maskSecret(half.secret), expiresAt: half.expiresAt };
    }
    return { state: half.status, maskedSecret: null, expiresAt: null };
  }

  function makeRealApp() {
    const app = new Hono();
    const dir = scratch();
    const vault = new SelfApolloVault(
      new SealedStore({ dir, keyProvider: () => parseMasterKey(MASTER_KEY) }),
    );
    const loop = new SelfConnectorLoop({
      baseUrl: "http://pythia.self",
      fetchImpl: createInProcessFetch(app),
      vault,
    });
    async function status(): Promise<SelfConnectorStatus> {
      const loopStatus = loop.status();
      return {
        standardAccount: vault.standardAccount(),
        smartAccount: vault.smartAccount(),
        dualLinkKey: vault.dualLinkKey(),
        standard: toHalfView(loopStatus.standard),
        smart: toHalfView(loopStatus.smart),
      };
    }
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      {
        selfConnector: {
          status,
          generate: async () => {
            await vault.ensureGenerated();
            return status();
          },
          link: async (dualLinkKey: string) => {
            vault.setDualLinkKey(dualLinkKey);
            return status();
          },
        },
      },
    );
    return app;
  }

  it("reports not-generated before generation, then a populated not-linked status after POST /admin/self-connector/generate", async () => {
    const app = makeRealApp();
    const cookie = await ancientCookie();

    const before = await app.request("/admin/self-connector", { headers: { cookie } });
    expect(await before.json()).toEqual({
      standardAccount: null,
      smartAccount: null,
      dualLinkKey: null,
      standard: { state: "not-generated", maskedSecret: null, expiresAt: null },
      smart: { state: "not-generated", maskedSecret: null, expiresAt: null },
    });

    const genRes = await app.request("/admin/self-connector/generate", {
      method: "POST",
      headers: { cookie },
    });
    const generated = (await genRes.json()) as SelfConnectorStatus;
    expect(generated.standardAccount).not.toBeNull();
    expect(generated.smartAccount).not.toBeNull();
    // Generated, but no dual-link-key posted yet — "not-linked", not "pending".
    expect(generated.standard).toEqual({ state: "not-linked", maskedSecret: null, expiresAt: null });
    expect(generated.smart).toEqual({ state: "not-linked", maskedSecret: null, expiresAt: null });

    // A second GET reads back the same populated state — generation persisted.
    const after = await app.request("/admin/self-connector", { headers: { cookie } });
    expect(await after.json()).toEqual(generated);
  });

  it("POST /admin/self-connector/link with the real generated pair's own accounts succeeds and the subsequent GET echoes the posted dualLinkKey", async () => {
    const app = makeRealApp();
    const cookie = await ancientCookie();

    const genRes = await app.request("/admin/self-connector/generate", {
      method: "POST",
      headers: { cookie },
    });
    const generated = (await genRes.json()) as SelfConnectorStatus;
    const dualLinkKey = `${generated.standardAccount}${DUAL_LINK_BAR}${generated.smartAccount}`;

    const linkRes = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey }),
    });
    expect(linkRes.status).toBe(200);
    const linked = (await linkRes.json()) as SelfConnectorStatus;
    expect(linked.dualLinkKey).toBe(dualLinkKey);

    const after = await app.request("/admin/self-connector", { headers: { cookie } });
    const afterStatus = (await after.json()) as SelfConnectorStatus;
    expect(afterStatus.dualLinkKey).toBe(dualLinkKey);
    // No tick has run in this describe block (no stub connector-auth server is
    // wired here — that's `selfConnectorLoop.test.ts`'s job) so the internal
    // `DualLinkConnector` hasn't been built yet: both halves still read
    // "not-linked" from `SelfConnectorLoop.status()`'s own cache, even though
    // a key IS now set — it only flips to "pending" on the first `tick()`.
    expect(afterStatus.standard.state).toBe("not-linked");
    expect(afterStatus.smart.state).toBe("not-linked");
  });

  it("POST /admin/self-connector/link with a key that doesn't match this vault's own accounts is rejected with a real 400 from the REAL vault's own validation, and dualLinkKey stays unset", async () => {
    // The two existing link tests above only ever exercise the SUCCESS path
    // (a matching key) for real, or a FAKE thrown error against the T4 fake
    // `selfConnector` — neither drives the route's try/catch against a REAL
    // `SelfApolloVault.setDualLinkKey()` throw, which is what production
    // actually calls (see `index.ts`'s `link` closure, mirrored by
    // `makeRealApp` above). This proves that real path end to end.
    const app = makeRealApp();
    const cookie = await ancientCookie();

    const genRes = await app.request("/admin/self-connector/generate", {
      method: "POST",
      headers: { cookie },
    });
    const generated = (await genRes.json()) as SelfConnectorStatus;

    // A well-formed key, but with a standard half from a DIFFERENT,
    // independently-generated pair — genuinely mismatched, not just
    // malformed (mirrors selfApollo.test.ts's own mismatch fixture).
    const otherDir = mkdtempSync(join(tmpdir(), "pyth-selfconn-real-other-"));
    tmpDirs.push(otherDir);
    const otherVault = new SelfApolloVault(
      new SealedStore({ dir: otherDir, keyProvider: () => parseMasterKey(MASTER_KEY) }),
    );
    const { standardAccount: otherStandardAccount } = await otherVault.ensureGenerated();
    const mismatchedKey = `${otherStandardAccount}${DUAL_LINK_BAR}${generated.smartAccount}`;

    const linkRes = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey: mismatchedKey }),
    });
    expect(linkRes.status).toBe(400);
    const body = (await linkRes.json()) as { error: string };
    expect(body.error).toMatch(/does not match/);
    expect(body.error).toMatch(/standard/);

    const after = await app.request("/admin/self-connector", { headers: { cookie } });
    expect((await after.json() as SelfConnectorStatus).dualLinkKey).toBeNull();
  });
});
