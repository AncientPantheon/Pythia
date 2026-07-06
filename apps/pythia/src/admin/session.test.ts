import { describe, it, expect } from "vitest";
import {
  signLoginState,
  readLoginState,
  signSession,
  readSession,
} from "./session.js";

const SECRET = "y".repeat(32);
const OTHER = "z".repeat(32);

describe("admin cookies", () => {
  it("round-trips transient login state", async () => {
    const token = await signLoginState(
      { state: "s", nonce: "n", codeVerifier: "v" },
      SECRET,
    );
    expect(await readLoginState(token, SECRET)).toMatchObject({
      purpose: "login",
      state: "s",
      nonce: "n",
      codeVerifier: "v",
    });
  });

  it("round-trips an authenticated session", async () => {
    const token = await signSession(
      { sub: "u1", roles: ["ancient"], name: "Ancient One" },
      SECRET,
    );
    expect(await readSession(token, SECRET)).toMatchObject({
      purpose: "session",
      sub: "u1",
      roles: ["ancient"],
      name: "Ancient One",
    });
  });

  it("rejects a cookie signed with a different secret", async () => {
    const token = await signSession({ sub: "u1", roles: [], name: "x" }, SECRET);
    expect(await readSession(token, OTHER)).toBeNull();
  });

  it("does not accept a login cookie as a session (purpose separation)", async () => {
    const token = await signLoginState(
      { state: "s", nonce: "n", codeVerifier: "v" },
      SECRET,
    );
    expect(await readSession(token, SECRET)).toBeNull();
  });

  it("does not accept a session cookie as login state", async () => {
    const token = await signSession({ sub: "u", roles: [], name: "x" }, SECRET);
    expect(await readLoginState(token, SECRET)).toBeNull();
  });

  it("returns null for absent or malformed cookies", async () => {
    expect(await readSession(undefined, SECRET)).toBeNull();
    expect(await readSession("not.a.jwt", SECRET)).toBeNull();
  });
});
