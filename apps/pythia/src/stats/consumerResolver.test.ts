import { describe, it, expect } from "vitest";
import { makeResolveConsumer, type ConsumerResolverDeps } from "./consumerResolver.js";

function make(overrides: Partial<ConsumerResolverDeps> = {}) {
  const deps: ConsumerResolverDeps = {
    selfSecret: () => null,
    resolveEphemeral: () => null,
    nameForKey: () => null,
    envConsumer: () => undefined,
    selfLabel: "pythia-self",
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

  it("a KEYLESS read is ALWAYS Pythia's own → 'pythia-self' (the fix), regardless of self-connector state", () => {
    // Was the bug: with the self-connector inactive, keyless reads resolved to
    // "direct"/Anonymous, so "Pythia (self)" showed 0 petitions despite her reading.
    expect(make({ selfSecret: () => null })()).toEqual({ consumer: "pythia-self", keyed: false });
    expect(make({ selfSecret: () => undefined })()).toEqual({ consumer: "pythia-self", keyed: false });
  });

  it("a KEYLESS read EARNS (keyed) only when Pythia has an active self-connector", () => {
    // label is always pythia-self; keyed follows self-connector activity (economics preserved).
    expect(make({ selfSecret: () => "SELF" })()).toEqual({ consumer: "pythia-self", keyed: true });
  });

  it("a caller explicitly presenting Pythia's self secret → 'pythia-self', keyed", () => {
    const r = make({ selfSecret: () => "SELF", resolveEphemeral: () => ({ apolloAccount: "x" }) });
    expect(r("SELF")).toEqual({ consumer: "pythia-self", keyed: true });
  });

  it("a real consumer's own key is NOT shadowed by the self label", () => {
    const r = make({
      selfSecret: () => "SELF",
      resolveEphemeral: (s) => (s === "OTHER" ? { apolloAccount: "₱.other" } : null),
    });
    expect(r("OTHER")).toEqual({ consumer: "₱.other", keyed: true });
  });

  it("a key that resolves to NOTHING (unknown/expired) → 'direct', NOT keyed", () => {
    expect(make()("nope")).toEqual({ consumer: "direct", keyed: false });
  });
});
