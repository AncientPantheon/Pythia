import { describe, it, expect } from "vitest";
import { createLoginChallenge, deriveCodeChallenge } from "./pkce.js";

describe("pkce", () => {
  it("derives an S256 challenge that matches its verifier", () => {
    const ch = createLoginChallenge();
    expect(deriveCodeChallenge(ch.codeVerifier)).toBe(ch.codeChallenge);
  });

  it("mints distinct random state / nonce / verifier per call", () => {
    const a = createLoginChallenge();
    const b = createLoginChallenge();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("emits url-safe base64 without padding", () => {
    const ch = createLoginChallenge();
    for (const v of [ch.state, ch.nonce, ch.codeVerifier, ch.codeChallenge]) {
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
