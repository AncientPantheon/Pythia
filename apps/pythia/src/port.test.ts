import { describe, it, expect } from "vitest";
import { resolvePort, DEFAULT_PORT } from "./port.js";

describe("resolvePort — PORT env contract", () => {
  it("returns the DEFAULT_PORT when PORT is unset", () => {
    // A bare container run with no PORT must bind the documented default (8080),
    // matching the Dockerfile EXPOSE.
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8080);
  });

  it("parses a valid numeric PORT and binds it", () => {
    // Operators override the port via env; a valid value must be honored so the
    // container binds where the ingress expects it.
    expect(resolvePort({ PORT: "3000" })).toBe(3000);
  });

  it("falls back to the default for an empty or whitespace PORT", () => {
    // An empty env value (common in mis-set compose files) must not crash the
    // bind — it degrades to the default.
    expect(resolvePort({ PORT: "" })).toBe(DEFAULT_PORT);
    expect(resolvePort({ PORT: "   " })).toBe(DEFAULT_PORT);
  });

  it("falls back to the default for a non-numeric PORT", () => {
    // A garbage value must not be passed to serve() as NaN.
    expect(resolvePort({ PORT: "not-a-port" })).toBe(DEFAULT_PORT);
  });

  it("rejects zero and negative ports, using the default instead", () => {
    // 0 and negatives are not valid TCP bind ports; the default protects the bind.
    expect(resolvePort({ PORT: "0" })).toBe(DEFAULT_PORT);
    expect(resolvePort({ PORT: "-1" })).toBe(DEFAULT_PORT);
  });
});
