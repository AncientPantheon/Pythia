import { describe, it, expect } from "vitest";
import { verifyStore } from "./store.js";

// The store is a module singleton; every test uses a fresh session id, so proven
// sets stay isolated without a reset hook.
describe("verifyStore", () => {
  it("issues a live challenge and looks it up by nonce", () => {
    const sid = verifyStore.newSessionId();
    const ch = verifyStore.issue(sid, "₱.a", "Π.b");
    expect(ch.nonce).toHaveLength(48); // 24 random bytes, hex
    expect(verifyStore.get(ch.nonce)).toMatchObject({
      sessionId: sid,
      standard: "₱.a",
      smart: "Π.b",
    });
  });

  it("returns null for an unknown nonce", () => {
    expect(verifyStore.get("nope")).toBeNull();
  });

  it("consumes each half once (replay-safe), keeping the challenge for the sibling", () => {
    const sid = verifyStore.newSessionId();
    const ch = verifyStore.issue(sid, "₱.a", "Π.b");
    expect(verifyStore.consumeHalf(ch.nonce, "₱.a")).toBe(true);
    expect(verifyStore.consumeHalf(ch.nonce, "₱.a")).toBe(false); // replay of same half
    expect(verifyStore.consumeHalf(ch.nonce, "Π.b")).toBe(true); // sibling still consumable
    expect(verifyStore.consumeHalf("no-such-nonce", "₱.a")).toBe(false);
  });

  it("tracks proven accounts per session, isolated across sessions", () => {
    const sid = verifyStore.newSessionId();
    expect(verifyStore.provenAccounts(sid)).toEqual([]);
    verifyStore.markProven(sid, "₱.a");
    verifyStore.markProven(sid, "Π.b");
    expect(verifyStore.provenAccounts(sid).sort()).toEqual(["Π.b", "₱.a"].sort());
    // A different session sees none of it.
    expect(verifyStore.provenAccounts(verifyStore.newSessionId())).toEqual([]);
  });
});
