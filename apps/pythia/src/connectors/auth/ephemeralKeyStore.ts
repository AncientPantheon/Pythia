import { randomBytes, createHash } from "node:crypto";

/** Ephemeral secrets refresh every 3 hours (design.md Decision 2). */
export const EPHEMERAL_SECRET_TTL_MS = 3 * 60 * 60 * 1000;

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface EphemeralKeyEntry {
  apolloAccount: string;
  expiresAt: number;
}

function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface EphemeralKeyStoreOptions {
  /** Injectable clock for deterministic expiry tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Sweep cadence for the background loop. Default 5 minutes. */
  sweepIntervalMs?: number;
}

/**
 * The gated-request bearer secret store — mints short-lived `pk_eph_...`
 * secrets for a headlessly-verified Apollo account (see
 * `docs/work/pythia-connector-protocol/design.md`). Mirrors `ConnectorStore`'s
 * hash-only-storage convention: the raw secret is returned exactly once, at
 * `issue()`, and never retained anywhere in this store's state — only its
 * SHA-256 hash, keyed by that hash.
 */
export class EphemeralKeyStore {
  private readonly entries = new Map<string, EphemeralKeyEntry>();
  private readonly clock: () => number;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: EphemeralKeyStoreOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Mint a fresh ephemeral secret for `apolloAccount`. Returned raw, once. */
  issue(apolloAccount: string): { secret: string; expiresAt: number } {
    const secret = `pk_eph_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.clock() + EPHEMERAL_SECRET_TTL_MS;
    this.entries.set(hashSecret(secret), { apolloAccount, expiresAt });
    return { secret, expiresAt };
  }

  /**
   * Resolve a raw secret to its owning account. Returns `null` for an unknown
   * or expired secret, deleting the entry in the expired case so it can never
   * resolve again.
   */
  resolve(secret: string): { apolloAccount: string } | null {
    const hash = hashSecret(secret);
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(hash);
      return null;
    }
    return { apolloAccount: entry.apolloAccount };
  }

  /** Purge every expired entry. Returns the number removed. */
  sweepExpired(): number {
    const now = this.clock();
    let removed = 0;
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweepExpired();
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
