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
import { CodexStore } from "../automaton/codexStore.js";
import { seedCodexWithRealPair } from "../automaton/codexApolloFixtures.js";
import { createInProcessFetch } from "../connectors/self/inProcessFetch.js";
import { maskSecret, DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";
import { registerConnectorAuth } from "../routes/connectorAuth.js";
import { AuthNonceStore } from "../connectors/auth/nonceStore.js";
import { EphemeralKeyStore } from "../connectors/auth/ephemeralKeyStore.js";
import { DualLinkCache } from "../connectors/auth/dualLinkCache.js";

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

describe("admin /admin/self-connector — SelfConnectorAdminControls extra", () => {
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
    standard: { state: "active" },
    smart: { state: "pending" },
    maskedSecret: "pk_eph_...abcdefg",
    expiresAt: 1_700_000_000_000,
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

  it("POST /admin/self-connector/generate no longer exists — 404s (route removed along with generate())", async () => {
    const res = await makeApp(true).request("/admin/self-connector/generate", {
      method: "POST",
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const res = await makeApp(true).request("/admin/self-connector");
    expect(res.status).toBe(401);
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

describe("admin /admin/self-connector — REAL SelfApolloVault + SelfConnectorLoop wiring", () => {
  // The FAKE suite above proves the route contract against a FAKE
  // SelfConnectorAdminControls; this proves the composition-root's own
  // status()/link() shape (mirrored here — index.ts itself has no
  // test-import surface, see selfConnectorIntegration.test.ts's doc comment)
  // actually round-trips when driven by REAL SelfApolloVault/SelfConnectorLoop/
  // CodexStore instances: null/not-linked before a paste, populated + pending
  // after — there's no local generation step to drive through anymore, so
  // Codex's own ouroAccounts snapshot is seeded directly, mirroring T2's own
  // `seedCodexWithRealPair` fixture (`selfApollo.test.ts`).
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
  // that task's doc comment): a half's view is now JUST its state — the
  // ephemeral secret is a single top-level value (see `status()` below),
  // not a per-half one (`docs/work/self-connector-panel-redesign/design.md`).
  function toHalfView(half: SelfConnectorHalfStatus): SelfConnectorHalfView {
    return { state: half.status };
  }

  function makeCodex(): CodexStore {
    return new CodexStore(
      new SealedStore({ dir: scratch(), keyProvider: () => parseMasterKey(MASTER_KEY) }),
    );
  }

  // `seedCodexWithRealPair` is imported from `../automaton/codexApolloFixtures.js`
  // (see the top-of-file import) rather than defined locally here — that file's
  // own doc comment explains why: `encryptStringV2` may only be imported from
  // inside `automaton/`, per `keyless-invariant.test.ts`'s directory-scoped
  // (not filename-scoped) exemption for this specific check.

  function makeRealApp(codex: CodexStore) {
    const app = new Hono();
    const dir = scratch();
    const vault = new SelfApolloVault(
      new SealedStore({ dir, keyProvider: () => parseMasterKey(MASTER_KEY) }),
      codex,
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
        maskedSecret: loopStatus.secret ? maskSecret(loopStatus.secret) : null,
        expiresAt: loopStatus.expiresAt,
      };
    }
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      {
        selfConnector: {
          status,
          link: async (dualLinkKey: string) => {
            vault.setDualLinkKey(dualLinkKey);
            // Mirrors index.ts's own `link` closure exactly (post-v2.7.1
            // fix): drive an immediate tick rather than leaving the admin
            // staring at a stale status until the next scheduled interval.
            await loop.tick();
            return status();
          },
        },
      },
    );
    return app;
  }

  it("reports null accounts and not-linked halves before any dualLinkKey is posted, even though Codex already holds a real pair", async () => {
    const codex = makeCodex();
    await seedCodexWithRealPair(codex);
    const app = makeRealApp(codex);
    const cookie = await ancientCookie();

    const res = await app.request("/admin/self-connector", { headers: { cookie } });
    const body = (await res.json()) as SelfConnectorStatus;
    expect(body).toEqual({
      standardAccount: null,
      smartAccount: null,
      dualLinkKey: null,
      standard: { state: "not-linked" },
      smart: { state: "not-linked" },
      maskedSecret: null,
      expiresAt: null,
    });
    // Explicit on the two NEW top-level fields specifically: nothing has
    // ticked yet in this test, so the consolidated secret/expiry stay null
    // too, same as each half individually.
    expect(body.maskedSecret).toBeNull();
    expect(body.expiresAt).toBeNull();
  });

  it("POST /admin/self-connector/link with the codex-held pair's own dual-link-key succeeds, drives an IMMEDIATE tick (post-v2.7.1 fix — no more waiting up to 24h for the scheduled interval), and the subsequent GET echoes the key with both halves now pending", async () => {
    const codex = makeCodex();
    const pair = await seedCodexWithRealPair(codex);
    const app = makeRealApp(codex);
    const cookie = await ancientCookie();
    const dualLinkKey = `${pair.standardAccount}${DUAL_LINK_BAR}${pair.smartAccount}`;

    const linkRes = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey }),
    });
    expect(linkRes.status).toBe(200);
    const linked = (await linkRes.json()) as SelfConnectorStatus;
    expect(linked.dualLinkKey).toBe(dualLinkKey);
    expect(linked.standardAccount).toBe(pair.standardAccount);
    expect(linked.smartAccount).toBe(pair.smartAccount);
    // `link()` now calls `loop.tick()` immediately (mirrors index.ts's own
    // fixed closure) — this describe block registers NO stub connector-auth
    // routes on `app` (that's `selfConnectorLoop.test.ts`'s job, with its own
    // `buildStubApp`), so the real attempt 404s per half, caught by
    // `DualLinkConnector.tickHalf`'s own error isolation — the internal
    // connector IS now built (unlike before this fix), so status reads
    // "pending" (its default steady state), NOT the stale "not-linked".
    expect(linked.standard.state).toBe("pending");
    expect(linked.smart.state).toBe("pending");

    const after = await app.request("/admin/self-connector", { headers: { cookie } });
    const afterStatus = (await after.json()) as SelfConnectorStatus;
    expect(afterStatus.dualLinkKey).toBe(dualLinkKey);
    expect(afterStatus.standard.state).toBe("pending");
    expect(afterStatus.smart.state).toBe("pending");
  });

  it("POST /admin/self-connector/link with a half not held by Pythia's own Codex is rejected with a real 400 from the REAL vault's own validation, and dualLinkKey stays unset", async () => {
    // The link test above only ever exercises the SUCCESS path (a matching,
    // codex-held key) for real, or a FAKE thrown error against the FAKE
    // `selfConnector` suite above — neither drives the route's try/catch
    // against a REAL `SelfApolloVault.setDualLinkKey()` throw, which is what
    // production actually calls (see `index.ts`'s `link` closure, mirrored by
    // `makeRealApp` above). This proves that real path end to end.
    const codex = makeCodex();
    const pair = await seedCodexWithRealPair(codex);
    const app = makeRealApp(codex);
    const cookie = await ancientCookie();

    // A well-formed key, but the standard half comes from an account that was
    // NEVER seeded into this codex's own snapshot at all — genuinely not
    // held, not just malformed (mirrors selfApollo.test.ts's own "missing
    // half" fixture — "not held by Codex", not "a different vault's
    // generated account", which no longer means anything).
    const registry = await import("@ouronet/dalos-crypto/registry");
    const unrelated = registry.Apollo.generateRandom();
    const mismatchedKey = `${unrelated.standardAddress}${DUAL_LINK_BAR}${pair.smartAccount}`;

    const linkRes = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey: mismatchedKey }),
    });
    expect(linkRes.status).toBe(400);
    const body = (await linkRes.json()) as { error: string };
    expect(body.error).toMatch(/not held by Pythia's own Codex/);
    expect(body.error).toMatch(/standard/);

    const after = await app.request("/admin/self-connector", { headers: { cookie } });
    expect((await after.json() as SelfConnectorStatus).dualLinkKey).toBeNull();
  });

  it("once a real tick reaches active (real Codex-backed signing round trip against a REAL registerConnectorAuth on the same app), maskedSecret is a genuinely masked string — never the raw secret", async () => {
    // Every other test in this describe block registers ONLY `registerAdmin`
    // on `app`, so any tick a `link()` call triggers necessarily 404s per
    // half and status can never progress past "pending" — which means the
    // `maskedSecret: loopStatus.secret ? maskSecret(loopStatus.secret) : null`
    // ternary's TRUTHY branch (the one line standing between Pythia's real
    // `x-pythia-key` value and an admin session response) was never exercised
    // anywhere in this suite (CONFIRMED HIGH, review round of
    // docs/work/self-connector-panel-redesign). This test is the one place
    // that registers a REAL `registerConnectorAuth` alongside `registerAdmin`
    // on the same app, with a `DualLinkCache` pre-seeded active for the
    // seeded pair and `readApolloPublicKey` resolving to the pair's REAL
    // public keys — so `SelfConnectorLoop.tick()` drives a genuine
    // challenge/verify/sign round trip (real Codex-backed Apollo signatures,
    // via `SelfApolloVault.createSigner`) all the way to "active", and a real
    // ephemeral secret gets issued and masked.
    const codex = makeCodex();
    const pair = await seedCodexWithRealPair(codex);
    const app = new Hono();
    const dir = scratch();
    const vault = new SelfApolloVault(
      new SealedStore({ dir, keyProvider: () => parseMasterKey(MASTER_KEY) }),
      codex,
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
        maskedSecret: loopStatus.secret ? maskSecret(loopStatus.secret) : null,
        expiresAt: loopStatus.expiresAt,
      };
    }
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      {
        selfConnector: {
          status,
          link: async (dualLinkKey: string) => {
            vault.setDualLinkKey(dualLinkKey);
            await loop.tick();
            return status();
          },
        },
      },
    );
    const dualLinkCache = new DualLinkCache({
      poll: async () => new Set([pair.standardAccount, pair.smartAccount]),
    });
    await dualLinkCache.refreshNow();
    registerConnectorAuth(app, {
      nonceStore: new AuthNonceStore(),
      ephemeralKeyStore: new EphemeralKeyStore(),
      dualLinkCache,
      readApolloPublicKey: async (apolloAccount: string) =>
        apolloAccount === pair.standardAccount ? pair.standardPublicKey : pair.smartPublicKey,
    });

    const cookie = await ancientCookie();
    const dualLinkKey = `${pair.standardAccount}${DUAL_LINK_BAR}${pair.smartAccount}`;
    const linkRes = await app.request("/admin/self-connector/link", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dualLinkKey }),
    });
    expect(linkRes.status).toBe(200);
    const linked = (await linkRes.json()) as SelfConnectorStatus;
    expect(linked.standard.state).toBe("active");
    expect(linked.smart.state).toBe("active");

    // The RAW secret, read directly off the loop (test-only visibility — the
    // route never exposes this) — used as the independent oracle to prove
    // `maskedSecret` is a real, correctly-masked transform of it, not the raw
    // value itself and not a fixture placeholder.
    const rawSecret = loop.status().secret;
    expect(rawSecret).not.toBeNull();
    expect(linked.maskedSecret).toBe(maskSecret(rawSecret as string));
    expect(linked.maskedSecret).not.toBe(rawSecret);
    expect(linked.maskedSecret).not.toBeNull();
    expect(linked.expiresAt).not.toBeNull();

    // The subsequent GET must echo the exact same masked value — proving the
    // route's own computation (not just this test's local `status()` helper)
    // takes the same truthy branch on a genuinely active loop.
    const after = await app.request("/admin/self-connector", { headers: { cookie } });
    const afterStatus = (await after.json()) as SelfConnectorStatus;
    expect(afterStatus.maskedSecret).toBe(linked.maskedSecret);
    expect(afterStatus.maskedSecret).not.toBe(rawSecret);
  });
});
