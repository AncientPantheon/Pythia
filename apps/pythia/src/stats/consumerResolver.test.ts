import { describe, it, expect } from "vitest";
import { makeResolveConsumer, type ConsumerResolverDeps } from "./consumerResolver.js";

function make(overrides: Partial<ConsumerResolverDeps> = {}) {
  const deps: ConsumerResolverDeps = {
    selfSecret: () => null,
    resolveEphemeral: () => null,
    nameForKey: () => null,
    envConsumer: () => undefined,
    selfLabel: () => "pythia-self",
    ...overrides,
  };
  return makeResolveConsumer(deps);
}

describe("makeResolveConsumer", () => {
  it("resolves an ephemeral key to its Apollo account, keyed", () => {
    const r = make({ resolveEphemeral: (s) => (s === "EPH" ? { apolloAccount: "₱.acme" } : null) });
    expect(r("EPH")).toEqual({ consumer: "₱.acme", keyed: true });
  });

  it("falls back to the permanent-connector name, then the env map (both keyed)", () => {
    expect(make({ nameForKey: (k) => (k === "pk_live_x" ? "acme" : null) })("pk_live_x")).toEqual({
      consumer: "acme",
      keyed: true,
    });
    expect(make({ envConsumer: (k) => (k === "envkey" ? "oracle" : undefined) })("envkey")).toEqual({
      consumer: "oracle",
      keyed: true,
    });
  });

  it("a KEYLESS read is 'direct', NOT keyed — the no-key→self shortcut is gone (read-gate hardening)", () => {
    // Post-hardening: a keyless request is never ASSUMED to be Pythia. Her own website
    // reads arrive with her self secret injected server-side (effectiveKey.ts) → they
    // resolve via the explicit self-secret branch, not here. A genuinely keyless request
    // is rejected by the gate before it is metered. Independent of self-connector state.
    expect(make({ selfSecret: () => null })()).toEqual({ consumer: "direct", keyed: false });
    expect(make({ selfSecret: () => undefined })()).toEqual({ consumer: "direct", keyed: false });
    expect(make({ selfSecret: () => "SELF" })()).toEqual({ consumer: "direct", keyed: false });
  });

  it("a caller explicitly presenting Pythia's self secret → 'pythia-self', keyed", () => {
    const r = make({ selfSecret: () => "SELF", resolveEphemeral: () => ({ apolloAccount: "x" }) });
    expect(r("SELF")).toEqual({ consumer: "pythia-self", keyed: true });
  });

  it("self identity is DYNAMIC: selfSecret AND the marker resolve to Pythia's self Apollo (unify under her dual-link key)", () => {
    // The fix: Pythia's own reads attribute to her self dual-link Apollo (her KEYED
    // self-connector), not a static "pythia-self" bucket. selfLabel() returns the Apollo.
    const r = make({ selfLabel: () => "₱.pythia-self-apollo", selfSecret: () => "SELF", firstPartyMarker: "fp_m" });
    expect(r("SELF")).toEqual({ consumer: "₱.pythia-self-apollo", keyed: true }); // current self secret
    expect(r("fp_m")).toEqual({ consumer: "₱.pythia-self-apollo", keyed: false }); // marker (no active secret)
  });

  it("a real consumer's own key is NOT shadowed by the self label", () => {
    const r = make({
      selfSecret: () => "SELF",
      resolveEphemeral: (s) => (s === "OTHER" ? { apolloAccount: "₱.other" } : null),
    });
    expect(r("OTHER")).toEqual({ consumer: "₱.other", keyed: true });
  });

  it("the injected first-party marker → 'pythia-self', NOT keyed (same-origin read, no active self secret)", () => {
    const r = make({ firstPartyMarker: "fp_marker", selfSecret: () => null });
    expect(r("fp_marker")).toEqual({ consumer: "pythia-self", keyed: false });
    // Without the marker dep wired, that same string is just an unknown key → direct.
    expect(make()("fp_marker")).toEqual({ consumer: "direct", keyed: false });
  });

  it("a key that resolves to NOTHING (unknown/expired) → 'direct', NOT keyed", () => {
    expect(make()("nope")).toEqual({ consumer: "direct", keyed: false });
  });
});
