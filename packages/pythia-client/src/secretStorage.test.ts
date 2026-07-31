import { describe, it, expect } from "vitest";
import { InMemorySecretStorage } from "./secretStorage.js";

describe("InMemorySecretStorage", () => {
  it("returns null from load() before anything has ever been saved", async () => {
    // A fresh consumer (or fresh process) must not fabricate a secret out of
    // thin air — PythiaConnector relies on null meaning "no cached secret yet".
    const storage = new InMemorySecretStorage();

    await expect(storage.load()).resolves.toBeNull();
  });

  it("round-trips the exact entry saved, including its expiresAt number", async () => {
    // PythiaConnector trusts load() to hand back exactly what save() was given
    // (same secret string, same expiresAt) with no mutation/rounding along the way.
    const storage = new InMemorySecretStorage();
    const entry = { secret: "pk_live_abc123", expiresAt: 1_772_500_000_000 };

    await storage.save(entry);

    await expect(storage.load()).resolves.toEqual(entry);
  });

  it("clear() makes a subsequent load() return null", async () => {
    // A stale/rotated-out secret must not linger and be handed back by a later
    // load() once the connector has decided it's no longer valid.
    const storage = new InMemorySecretStorage();
    await storage.save({ secret: "pk_live_xyz", expiresAt: 1_000 });

    await storage.clear();

    await expect(storage.load()).resolves.toBeNull();
  });
});
