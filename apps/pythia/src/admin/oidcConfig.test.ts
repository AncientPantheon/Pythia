import { describe, it, expect } from "vitest";
import { loadOidcConfig } from "./oidcConfig.js";

const SECRET = "x".repeat(32);

describe("loadOidcConfig", () => {
  it("returns null when any required secret is absent", () => {
    expect(loadOidcConfig({})).toBeNull();
    expect(loadOidcConfig({ PYTHIA_OIDC_CLIENT_ID: "a" })).toBeNull();
    expect(
      loadOidcConfig({ PYTHIA_OIDC_CLIENT_ID: "a", PYTHIA_OIDC_CLIENT_SECRET: "b" }),
    ).toBeNull();
  });

  it("throws when the session secret is too short to sign safely", () => {
    expect(() =>
      loadOidcConfig({
        PYTHIA_OIDC_CLIENT_ID: "a",
        PYTHIA_OIDC_CLIENT_SECRET: "b",
        PYTHIA_SESSION_SECRET: "short",
      }),
    ).toThrow(/at least 32/);
  });

  it("builds config with the production defaults", () => {
    const cfg = loadOidcConfig({
      PYTHIA_OIDC_CLIENT_ID: "pythia",
      PYTHIA_OIDC_CLIENT_SECRET: "sec",
      PYTHIA_SESSION_SECRET: SECRET,
    });
    expect(cfg).toEqual({
      issuer: "https://ancientholdings.eu",
      clientId: "pythia",
      clientSecret: "sec",
      redirectUri: "https://pythia.ancientholdings.eu/admin/callback",
      sessionSecret: SECRET,
    });
  });

  it("strips a trailing slash from a custom issuer", () => {
    const cfg = loadOidcConfig({
      PYTHIA_OIDC_ISSUER: "https://hub.test/",
      PYTHIA_OIDC_CLIENT_ID: "a",
      PYTHIA_OIDC_CLIENT_SECRET: "b",
      PYTHIA_SESSION_SECRET: SECRET,
    });
    expect(cfg?.issuer).toBe("https://hub.test");
  });
});
