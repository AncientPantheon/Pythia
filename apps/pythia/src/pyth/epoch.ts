import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The on-chain calendar-day anchor (`PYTHIA|LEDGER-EPOCH-START`). Day 1 begins at this
 * instant. The canonical value is read ONCE from chain (`PYTHIA.UR_PythLedgerEpochStart`)
 * and cached; this constant is only the fallback used until that read succeeds (or when
 * the read gateway is down) — it must match the on-chain constant exactly.
 */
export const PYTH_EPOCH_DEFAULT_MS = Date.UTC(2026, 6, 21, 0, 0, 0); // 2026-07-21T00:00:00Z

export type EpochSource = "chain" | "cached" | "default";

export interface EpochStatus {
  /** Epoch as UTC ms. */
  epochMs: number;
  /** Epoch as an ISO string (day-1 anchor). */
  iso: string;
  /** Where the value came from: a live chain read this boot, a prior cached chain read,
   *  or the hardcoded default (chain not yet read / gateway down). */
  source: EpochSource;
  /** ISO of when the chain read that produced this value succeeded, or null for default. */
  readAt: string | null;
}

/**
 * Parse the `/local` result data of `UR_PythLedgerEpochStart` into epoch ms. Pact `time`
 * serializes as `{ time: "…" }` (or `timep`); some nodes return a bare ISO string. Returns
 * null for anything unparseable so the caller keeps the default.
 */
export function parseEpochResult(data: unknown): number | null {
  let raw: unknown = data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    raw = o.time ?? o.timep ?? null;
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export interface PythEpochOptions {
  filePath: string;
  /** Reads the epoch from chain, returning epoch ms or null on any failure. Injectable. */
  reader?: () => Promise<number | null>;
}

interface EpochSnapshot {
  epochMs: number;
  readAt: string;
}

/**
 * Reads + caches the ledger epoch. `resolve()` (best-effort, once at startup) reads the
 * on-chain anchor and persists it to `/data`; `epochMs()` is the value the ledger's
 * day-ordinal math uses; `status()` backs the admin readout. A persisted chain value
 * reloads on the next boot as `cached` until `resolve()` re-confirms it (`chain`).
 */
export class PythEpochStore {
  private readonly filePath: string;
  private readonly reader?: () => Promise<number | null>;
  private epoch = PYTH_EPOCH_DEFAULT_MS;
  private source: EpochSource = "default";
  private readAt: string | null = null;
  private writeWarned = false;

  constructor(options: PythEpochOptions) {
    this.filePath = options.filePath;
    this.reader = options.reader;
    this.loadFromDisk();
  }

  epochMs(): number {
    return this.epoch;
  }

  status(): EpochStatus {
    return {
      epochMs: this.epoch,
      iso: new Date(this.epoch).toISOString(),
      source: this.source,
      readAt: this.readAt,
    };
  }

  /** Read the epoch from chain (best-effort, non-fatal) and cache it. A `reader` override
   *  lets the composition root supply one built from the node pool (constructed after this
   *  store, which the ledger needs early for its day-ordinal getter). */
  async resolve(reader?: () => Promise<number | null>): Promise<void> {
    const read = reader ?? this.reader;
    if (!read) return;
    try {
      const ms = await read();
      if (ms !== null && Number.isFinite(ms)) {
        this.epoch = ms;
        this.source = "chain";
        this.readAt = new Date().toISOString();
        this.persist();
      }
    } catch {
      /* keep the default/cached value — the read gateway may be down */
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const snap = JSON.parse(readFileSync(this.filePath, "utf8")) as EpochSnapshot;
      if (snap && typeof snap.epochMs === "number" && Number.isFinite(snap.epochMs)) {
        this.epoch = snap.epochMs;
        this.source = "cached"; // chain-read on a prior boot
        this.readAt = typeof snap.readAt === "string" ? snap.readAt : null;
      }
    } catch {
      /* unreadable cache — keep the default */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const snap: EpochSnapshot = { epochMs: this.epoch, readAt: this.readAt ?? new Date().toISOString() };
      writeFileSync(tmp, JSON.stringify(snap), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      if (!this.writeWarned) {
        this.writeWarned = true;
        console.warn(
          `Pyth epoch cache write to ${this.filePath} failed — continuing in-memory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
