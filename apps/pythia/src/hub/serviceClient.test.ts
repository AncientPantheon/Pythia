import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  canonicalize,
  signEnvelope,
  loadHubConfig,
  HubServiceClient,
} from "./serviceClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("canonicalize", () => {
  it("sorts keys at every depth deterministically", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("is stable regardless of input key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
});

describe("signEnvelope", () => {
  it("signs HMAC-SHA256 over canonical({nonce,payload,timestamp})", () => {
    const env = signEnvelope({ x: 1 }, "secret", {
      nonce: "n1",
      timestamp: "2026-07-10T00:00:00Z",
    });
    const expected = createHmac("sha256", "secret")
      .update(canonicalize({ nonce: "n1", payload: { x: 1 }, timestamp: "2026-07-10T00:00:00Z" }))
      .digest("hex");
    expect(env.signature).toBe(expected);
    expect(env).toMatchObject({ nonce: "n1", timestamp: "2026-07-10T00:00:00Z", payload: { x: 1 } });
  });
  it("mints a fresh nonce each call", () => {
    expect(signEnvelope({}, "s").nonce).not.toBe(signEnvelope({}, "s").nonce);
  });
});

describe("loadHubConfig", () => {
  it("returns null without the HMAC secret (feed stays off)", () => {
    expect(loadHubConfig({})).toBeNull();
  });
  it("defaults the base URL to production", () => {
    expect(loadHubConfig({ PYTHIA_HUB_HMAC_SECRET: "abc" })).toEqual({
      baseUrl: "https://ancientholdings.eu",
      secret: "abc",
    });
  });
  it("honors a base-URL override and strips a trailing slash", () => {
    expect(
      loadHubConfig({ PYTHIA_HUB_HMAC_SECRET: "abc", HUB_BASE_URL: "https://hub.test/" }),
    ).toMatchObject({ baseUrl: "https://hub.test" });
  });
});

describe("HubServiceClient.fetchNodes", () => {
  it("POSTs a signed body to /api/pythia/nodes/ (trailing slash) and parses usable slots", async () => {
    let calledUrl = "";
    let calledInit: RequestInit = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledInit = init ?? {};
      return new Response(
        JSON.stringify({
          slots: [
            { id: "1.2.3.4", url: "https://1.2.3.4:1848", networkId: "stoa", operator: "k:a", atTip: true, height: 5 },
            { id: "5.6.7.8", url: "https://5.6.7.8:1848", networkId: "stoa", operator: null, atTip: false, height: 4 }, // not at tip → dropped
            { id: "9.9.9.9", url: "http://9.9.9.9:1848", networkId: "stoa", operator: null, atTip: true, height: 5 }, // not https → dropped
          ],
          refreshAfter: 60,
        }),
        { status: 200 },
      );
    });
    const client = new HubServiceClient({ baseUrl: "https://hub.test", secret: "s" }, fetchMock);
    const feed = await client.fetchNodes();

    expect(calledUrl).toBe("https://hub.test/api/pythia/nodes/");
    expect(calledInit.method).toBe("POST");
    const body = JSON.parse(String(calledInit.body));
    expect(body).toHaveProperty("signature");
    expect(body).toHaveProperty("nonce");
    expect(body).toHaveProperty("timestamp");
    expect(body.payload).toEqual({});

    expect(feed.refreshAfter).toBe(60);
    expect(feed.slots.map((s) => s.id)).toEqual(["1.2.3.4"]); // only the at-tip https slot survives
  });

  it("throws on a non-200 (so the pool keeps its last-good slots)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ reason: "ip_not_allowed" }), { status: 403 }));
    const client = new HubServiceClient({ baseUrl: "https://hub.test", secret: "s" }, fetchMock);
    await expect(client.fetchNodes()).rejects.toThrow(/403/);
  });
});
