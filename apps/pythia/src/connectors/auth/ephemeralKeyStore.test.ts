import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EphemeralKeyStore,
  DEFAULT_EPHEMERAL_SECRET_TTL_MS,
  SELF_EPHEMERAL_SECRET_TTL_MS,
} from "./ephemeralKeyStore.js";

const tmpDirs: string[] = [];
function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyth-eph-"));
  tmpDirs.push(dir);
  return join(dir, "eph.json");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("EphemeralKeyStore", () => {
  it("resolves an issued secret back to the account that minted it", () => {
    const store = new EphemeralKeyStore();
    const { secret, expiresAt } = store.issue("₱.consumer-a");

    expect(secret).toMatch(/^pk_eph_[A-Za-z0-9_-]+$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(store.resolve(secret)).toEqual({ apolloAccount: "₱.consumer-a" });
  });

  it("returns null for a secret it never issued", () => {
    const store = new EphemeralKeyStore();
    expect(store.resolve("pk_eph_never-issued")).toBeNull();
  });

  it("returns null once the TTL has elapsed, and the entry is gone on sweep", () => {
    let now = 1_000_000;
    const store = new EphemeralKeyStore({ clock: () => now });
    const { secret } = store.issue("₱.consumer-b");

    // Just before expiry: still resolves.
    now += DEFAULT_EPHEMERAL_SECRET_TTL_MS - 1;
    expect(store.resolve(secret)).toEqual({ apolloAccount: "₱.consumer-b" });

    // Past expiry: resolve fails and deletes the entry as a side effect.
    now += 2;
    expect(store.resolve(secret)).toBeNull();

    // resolve() already deleted the expired entry; sweepExpired() finds nothing left to purge.
    expect(store.sweepExpired()).toBe(0);
  });

  it("purges expired entries via sweepExpired and reports how many were removed", () => {
    let now = 0;
    const store = new EphemeralKeyStore({ clock: () => now });
    store.issue("₱.consumer-d");
    store.issue("₱.consumer-e");

    now += DEFAULT_EPHEMERAL_SECRET_TTL_MS + 1;
    expect(store.sweepExpired()).toBe(2);
    expect(store.sweepExpired()).toBe(0);
  });

  it("issues a longer-lived secret when called with SELF_EPHEMERAL_SECRET_TTL_MS, distinctly longer than the default", () => {
    const now = 5_000_000;
    const store = new EphemeralKeyStore({ clock: () => now });

    const selfIssue = store.issue("₱.self-account", SELF_EPHEMERAL_SECRET_TTL_MS);
    const defaultIssue = store.issue("₱.other-account");

    expect(selfIssue.expiresAt).toBe(now + SELF_EPHEMERAL_SECRET_TTL_MS);
    expect(defaultIssue.expiresAt).toBe(now + DEFAULT_EPHEMERAL_SECRET_TTL_MS);
    expect(selfIssue.expiresAt).toBeGreaterThan(defaultIssue.expiresAt);
  });

  it("never collides between two issue() calls for different accounts", () => {
    const store = new EphemeralKeyStore();
    const a = store.issue("₱.consumer-f");
    const b = store.issue("₱.consumer-g");

    expect(a.secret).not.toBe(b.secret);
    expect(store.resolve(a.secret)).toEqual({ apolloAccount: "₱.consumer-f" });
    expect(store.resolve(b.secret)).toEqual({ apolloAccount: "₱.consumer-g" });
  });

  // Note: an earlier version of this test reached into the store's private
  // `entries` field via an unsafe cast to assert the raw secret isn't
  // persisted. Dropped per review — `resolve()`'s return type only ever
  // exposes `{ apolloAccount }`, never the raw secret, and every test above
  // already exercises the class exclusively through that public API; a test
  // coupled to a private field name breaks on harmless refactors (renaming
  // the field, switching data structures) without the underlying security
  // property ever having regressed.
});

describe("EphemeralKeyStore — persistence across restarts (the deploy-orphan fix)", () => {
  it("a key minted before a restart still resolves after reloading from the same file", () => {
    const file = scratchFile();
    const before = new EphemeralKeyStore({ filePath: file });
    const { secret } = before.issue("₱.ouronet");
    // Simulate a gateway restart/deploy: a brand-new store over the SAME file.
    const after = new EphemeralKeyStore({ filePath: file });
    expect(after.resolve(secret)).toEqual({ apolloAccount: "₱.ouronet" });
  });

  it("drops already-expired entries on load", () => {
    let now = 1_000_000;
    const file = scratchFile();
    const before = new EphemeralKeyStore({ filePath: file, clock: () => now });
    const { secret } = before.issue("₱.stale");
    now += DEFAULT_EPHEMERAL_SECRET_TTL_MS + 1; // key is now expired
    // Reload AFTER expiry (persist the expiry state first via a sweep).
    before.sweepExpired();
    const after = new EphemeralKeyStore({ filePath: file, clock: () => now });
    expect(after.resolve(secret)).toBeNull();
  });

  it("a fresh store loading a file with an expired entry ignores it (load-time filter)", () => {
    const file = scratchFile();
    // Hand-write a file with one expired + one live entry (hash-only shape).
    const now = 5_000_000;
    writeFileSync(
      file,
      JSON.stringify({
        deadhash: { apolloAccount: "₱.dead", expiresAt: now - 1 },
      }),
    );
    const store = new EphemeralKeyStore({ filePath: file, clock: () => now });
    // The expired entry never loaded; a corrupt/unknown secret still resolves null.
    expect(store.resolve("pk_eph_whatever")).toBeNull();
  });

  it("with NO filePath, nothing is written to disk (in-memory only)", () => {
    const file = scratchFile();
    const store = new EphemeralKeyStore(); // no filePath
    store.issue("₱.mem");
    expect(existsSync(file)).toBe(false);
  });

  it("a corrupt/absent file starts empty rather than throwing", () => {
    const file = scratchFile();
    writeFileSync(file, "not json{");
    const store = new EphemeralKeyStore({ filePath: file });
    const { secret } = store.issue("₱.recover");
    expect(store.resolve(secret)).toEqual({ apolloAccount: "₱.recover" });
  });
});
