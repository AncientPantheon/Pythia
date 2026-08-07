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
  it("resolves an ephemeral key to its Apollo account", () => {
    const r = make({ resolveEphemeral: (s) => (s === "EPH" ? { apolloAccount: "₱.acme" } : null) });
    expect(r("EPH")).toBe("₱.acme");
  });

  it("falls back to the permanent-connector name, then the env map", () => {
    expect(make({ nameForKey: (k) => (k === "pk_live_x" ? "acme" : null) })("pk_live_x")).toBe("acme");
    expect(make({ envConsumer: (k) => (k === "envkey" ? "oracle" : undefined) })("envkey")).toBe("oracle");
  });

  it("a KEYLESS read with an active self-connector → the unified 'pythia-self' label (the fix)", () => {
    // Regression: previously this resolved to the self-connector's Apollo account,
    // splitting Pythia's reads away from her fires so "Pythia (self)" showed 0 petitions.
    const r = make({
      selfSecret: () => "SELF",
      resolveEphemeral: (s) => (s === "SELF" ? { apolloAccount: "₱.pythiaSelf" } : null),
    });
    expect(r()).toBe("pythia-self"); // NOT "₱.pythiaSelf"
  });

  it("a caller explicitly presenting Pythia's self secret also resolves to 'pythia-self'", () => {
    const r = make({ selfSecret: () => "SELF", resolveEphemeral: () => ({ apolloAccount: "x" }) });
    expect(r("SELF")).toBe("pythia-self");
  });

  it("a real consumer's own key is NOT shadowed by the self label", () => {
    const r = make({
      selfSecret: () => "SELF",
      resolveEphemeral: (s) => (s === "OTHER" ? { apolloAccount: "₱.other" } : null),
    });
    expect(r("OTHER")).toBe("₱.other");
  });

  it("keyless with NO active self-connector → 'direct'", () => {
    expect(make({ selfSecret: () => null })()).toBe("direct");
    expect(make({ selfSecret: () => undefined })()).toBe("direct");
  });

  it("an unknown key resolves to 'direct'", () => {
    expect(make()("nope")).toBe("direct");
  });
});
