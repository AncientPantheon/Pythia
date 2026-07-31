import { describe, it, expect } from "vitest";
import { readApolloCounterpart } from "./readApolloCounterpart.js";
import { PYTHIA_DUAL_LINK_BAR } from "./dualLinkCache.js";
import type { DialNode } from "../../dial/index.js";

const APOLLO_ACCOUNT = "₩.".padEnd(162, "s"); // arbitrary 162-char standard-shaped string
const COUNTERPART = "Π.".padEnd(162, "m"); // arbitrary 162-char smart-shaped string

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

describe("readApolloCounterpart", () => {
  it("returns the counterpart account string from a well-formed response", async () => {
    const fetchImpl = fakeChainFetch({ status: "success", data: COUNTERPART });

    const result = await readApolloCounterpart(FAKE_PAIR, APOLLO_ACCOUNT, { fetchImpl });

    expect(result).toBe(COUNTERPART);
  });

  it("returns null when the response data equals the on-chain unlinked BAR sentinel", async () => {
    const fetchImpl = fakeChainFetch({ status: "success", data: PYTHIA_DUAL_LINK_BAR });

    const result = await readApolloCounterpart(FAKE_PAIR, APOLLO_ACCOUNT, { fetchImpl });

    expect(result).toBeNull();
  });

  it("rejects (does not resolve to null) on a non-'success' status response", async () => {
    const fetchImpl = fakeChainFetch({ status: "failure", data: "some pact error" });

    await expect(
      readApolloCounterpart(FAKE_PAIR, APOLLO_ACCOUNT, { fetchImpl }),
    ).rejects.toThrow();
  });

  it("rejects on a 'success' status with malformed (non-string) data instead of silently returning null", async () => {
    const fetchImpl = fakeChainFetch({ status: "success", data: { unexpected: "shape" } });

    await expect(
      readApolloCounterpart(FAKE_PAIR, APOLLO_ACCOUNT, { fetchImpl }),
    ).rejects.toThrow();
  });

  it("rejects a well-formed STRING response that isn't a valid Apollo account shape (defense in depth: HIGH map-key-collision finding)", async () => {
    // A returned `data` that passes the type check but is the wrong length or
    // has no real ₱./Π. Apollo prefix must never be trusted as a genuine
    // counterpart account. (`pairKey` in pendingActivationTracker.ts is ALSO
    // independently made collision-free regardless of string content —
    // this check is defense in depth, not the sole mitigation.)
    const tooShort = fakeChainFetch({ status: "success", data: "not-a-real-account" });
    await expect(readApolloCounterpart(FAKE_PAIR, APOLLO_ACCOUNT, { fetchImpl: tooShort })).rejects.toThrow();

    const wrongPrefix = fakeChainFetch({ status: "success", data: "x".repeat(162) });
    await expect(
      readApolloCounterpart(FAKE_PAIR, APOLLO_ACCOUNT, { fetchImpl: wrongPrefix }),
    ).rejects.toThrow();
  });

  it("passes the account via Pact env-data — never interpolated into the executed code (regression: CRITICAL code-injection fix)", async () => {
    // An account string carrying a `"` would, if ever spliced directly into
    // the Pact code string, close the string literal and let the rest be
    // interpreted as further Pact source. This must reach the node ONLY as
    // opaque `data`, never as part of `code`.
    const injectionAttempt = `x" (some-injected-call) "`.padEnd(162, "z");
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ result: { status: "success", data: PYTHIA_DUAL_LINK_BAR } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await readApolloCounterpart(FAKE_PAIR, injectionAttempt, { fetchImpl });

    expect(capturedBody).toBeDefined();
    const { cmd } = JSON.parse(capturedBody!) as { cmd: string };
    const { payload } = JSON.parse(cmd) as { payload: { exec: { code: string; data: Record<string, unknown> } } };
    expect(payload.exec.code).not.toContain(injectionAttempt);
    expect(payload.exec.code).toBe('(ouronet-ns.PYTHIA.UR_Counterpart (read-string "acct"))');
    expect(payload.exec.data).toEqual({ acct: injectionAttempt });
  });
});
