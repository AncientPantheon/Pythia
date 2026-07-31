import { describe, it, expect } from "vitest";
import { DualLinkCache, splitDualLinkKey, readActiveDualLinkAccounts } from "./dualLinkCache.js";
import type { DialNode } from "../../dial/index.js";

const STANDARD = "₩.".padEnd(162, "s"); // arbitrary 162-char standard-shaped string
const SMART = "Π.".padEnd(162, "m"); // arbitrary 162-char smart-shaped string

function compositeKey(standard: string, smart: string): string {
  return `${standard}|${smart}`;
}

const FAKE_PAIR = {
  primary: { id: "n1", url: "https://n1.example" } as DialNode,
  fallback: { id: "n2", url: "https://n2.example" } as DialNode,
};

/** A fetchImpl that always answers with a Pact local `{result:{status,data}}` body. */
function fakeChainFetch(result: { status: string; data: unknown }) {
  return async () =>
    new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("splitDualLinkKey", () => {
  it("splits a known 325-char composite key into its standard and smart halves", () => {
    const key = compositeKey(STANDARD, SMART);
    expect(key.length).toBe(325);

    const { standard, smart } = splitDualLinkKey(key);
    expect(standard).toBe(STANDARD);
    expect(smart).toBe(SMART);
  });
});

describe("readActiveDualLinkAccounts", () => {
  it("rejects when a 'success' response's data is not an array, instead of resolving to an empty set", async () => {
    const fetchImpl = fakeChainFetch({ status: "success", data: { unexpected: "shape" } });
    await expect(
      readActiveDualLinkAccounts(FAKE_PAIR, { fetchImpl }),
    ).rejects.toThrow(/malformed data/);
  });

  it("skips a malformed-length key instead of splitting it, and still returns the well-formed key's accounts", async () => {
    const goodKey = compositeKey(STANDARD, SMART);
    const fetchImpl = fakeChainFetch({
      status: "success",
      data: [goodKey, "too-short-to-be-a-real-composite-key"],
    });

    const accounts = await readActiveDualLinkAccounts(FAKE_PAIR, { fetchImpl });

    expect(accounts.has(STANDARD)).toBe(true);
    expect(accounts.has(SMART)).toBe(true);
    // The malformed entry must not contribute a truncated/garbage account.
    expect(accounts.size).toBe(2);
  });
});

describe("DualLinkCache", () => {
  it("starts with an empty set — isActiveAccount is false for anything pre-poll", () => {
    const cache = new DualLinkCache({ poll: async () => new Set([STANDARD, SMART]) });
    expect(cache.isActiveAccount(STANDARD)).toBe(false);
    expect(cache.isActiveAccount(SMART)).toBe(false);
  });

  it("after a successful poll, isActiveAccount is true for both halves of a returned link and false for an unrelated account", async () => {
    const key = compositeKey(STANDARD, SMART);
    const { standard, smart } = splitDualLinkKey(key);
    const cache = new DualLinkCache({ poll: async () => new Set([standard, smart]) });

    await cache.refreshNow();

    expect(cache.isActiveAccount(standard)).toBe(true);
    expect(cache.isActiveAccount(smart)).toBe(true);
    expect(cache.isActiveAccount("some-unrelated-account")).toBe(false);
  });

  it("a poll rejection leaves the previous successful set intact (not cleared)", async () => {
    let shouldFail = false;
    const cache = new DualLinkCache({
      poll: async () => {
        if (shouldFail) throw new Error("chain unreachable");
        return new Set([STANDARD, SMART]);
      },
    });

    await cache.refreshNow();
    expect(cache.isActiveAccount(STANDARD)).toBe(true);

    shouldFail = true;
    await cache.refreshNow();

    // still reflects the last GOOD poll, not cleared by the failed one
    expect(cache.isActiveAccount(STANDARD)).toBe(true);
    expect(cache.isActiveAccount(SMART)).toBe(true);
  });
});
