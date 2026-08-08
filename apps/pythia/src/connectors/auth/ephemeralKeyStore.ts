import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Ephemeral secrets refresh every 6 hours by default (design.md Decision 2,
 * revised in docs/work/self-connector-dual-link/design.md — "differentiated
 * TTLs"). */
export const DEFAULT_EPHEMERAL_SECRET_TTL_MS = 6 * 60 * 60 * 1000;
/** Pythia's own self-connector identity gets a materially longer lifetime —
 * fewer unnecessary re-verifies for a long-lived internal identity. */
export const SELF_EPHEMERAL_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Optional file to persist minted keys across process restarts. In prod this is
   * a path on the MOUNTED VOLUME (like `ConnectorStore`'s file), so a deploy /
   * gateway restart does NOT orphan every consumer's live `pk_eph_` key — the
   * bug this fixes. Omit → in-memory only (the prior behavior; fine for tests).
   * Hash-only, exactly as in memory: the file holds SHA-256 hashes → {account,
   * expiresAt}, never a raw secret. Expired entries are dropped on load.
   */
  filePath?: string;
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
  private readonly filePath: string | undefined;
  private persistWarned = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: EphemeralKeyStoreOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.filePath = opts.filePath;
    if (this.filePath) this.load();
  }

  /** Load persisted entries, dropping any already expired. Absent/invalid file →
   * start empty (first mint materialises it). Never throws. */
  private load(): void {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        const now = this.clock();
        for (const [hash, raw] of Object.entries(parsed)) {
          const e = raw as { apolloAccount?: unknown; expiresAt?: unknown };
          if (
            typeof e?.apolloAccount === "string" &&
            typeof e.expiresAt === "number" &&
            Number.isFinite(e.expiresAt) &&
            e.expiresAt > now
          ) {
            this.entries.set(hash, { apolloAccount: e.apolloAccount, expiresAt: e.expiresAt });
          }
        }
      }
    } catch {
      /* absent or invalid — start empty */
    }
  }

  /** Atomically persist the current (hash-only) entries. Best-effort: a disk
   * failure warns once and NEVER breaks minting (the key still works this
   * process's lifetime). No-op when no `filePath` was configured. */
  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
      renameSync(tmp, this.filePath);
    } catch (err) {
      if (!this.persistWarned) {
        this.persistWarned = true;
        console.warn(
          `EphemeralKeyStore: failed to persist to ${this.filePath} — minted keys will not survive a restart`,
          err,
        );
      }
    }
  }

  /** Mint a fresh ephemeral secret for `apolloAccount`. Returned raw, once.
   * `ttlMs` defaults to `DEFAULT_EPHEMERAL_SECRET_TTL_MS` — callers that need
   * a different lifetime (e.g. `SELF_EPHEMERAL_SECRET_TTL_MS` for Pythia's own
   * identity) pass it explicitly. */
  issue(
    apolloAccount: string,
    ttlMs: number = DEFAULT_EPHEMERAL_SECRET_TTL_MS,
  ): { secret: string; expiresAt: number } {
    const secret = `pk_eph_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.clock() + ttlMs;
    this.entries.set(hashSecret(secret), { apolloAccount, expiresAt });
    this.persist(); // survive a restart — the whole point of this store's fix
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
    if (removed > 0) this.persist(); // keep the on-disk set tidy + current
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
