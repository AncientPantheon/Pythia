import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { round3 } from "./pondus.js";

/** The six counters of the Pyth ledger — mirrors the on-chain schema in
 * `docs/HANDOFF-pact-pyth-ledger.md`. `pondus` is a decimal; the rest integers. */
export interface LedgerCounters {
  petitions: number;
  pondus: number;
  transactions: number;
  gasReserved: number;
  failedTransactions: number;
  wastedGasReserved: number;
}

export interface DailyLedgerRow extends LedgerCounters {
  /** UTC "YYYY-MM-DD". */
  day: string;
}

/**
 * On-chain calendar-day anchor (`PYTHIA|LEDGER-EPOCH-START`). Day 1 begins at this
 * instant; the day ordinal a flush entry carries is `1 + floor((t − epoch)/86400s)`.
 * Must match the on-chain constant exactly. See docs/HANDOFF-pythia-khronoton-flush.md.
 */
export const PYTH_LEDGER_EPOCH_MS = Date.UTC(2026, 6, 21, 0, 0, 0); // 2026-07-21T00:00:00Z
const DAY_MS = 86_400_000;

/** The integer UTC calendar-day ordinal for a "YYYY-MM-DD" bucket key, against an epoch
 *  (defaults to the hardcoded anchor; the live ledger injects the chain-read epoch). */
export function dayOrdinal(dayKey: string, epochMs: number = PYTH_LEDGER_EPOCH_MS): number {
  const ms = Date.parse(`${dayKey}T00:00:00.000Z`);
  return 1 + Math.floor((ms - epochMs) / DAY_MS);
}

/**
 * One calendar day in an A_Flush batch — the exact on-chain `PythFlushEntry` schema
 * (kebab-case keys; `day` an integer ordinal; `pondus` a decimal ≤3dp). Counters are
 * cumulative for that UTC day. See `PythiaLedgerV2.PYTHIA|S|PythFlushEntry`.
 */
export interface PythFlushEntry {
  day: number;
  "iz-complete": boolean;
  petitions: number;
  pondus: number;
  transactions: number;
  "gas-reserved": number;
  "failed-transactions": number;
  "wasted-gas-reserved": number;
}

/** Opaque drain token: the exact per-day amounts a beginFlush snapshotted, subtracted
 *  back out by commitFlush on confirmed on-chain success. */
export interface FlushToken {
  readonly days: Record<string, LedgerCounters>;
}

/** The on-chain batch cap (`PYTHIA|MAX-FLUSH-BATCH`) — at most this many day entries/tx. */
export const MAX_FLUSH_BATCH = 1000;

export interface PythLedgerOptions {
  filePath: string;
  /** Persist interval in ms. 0 disables the timer (tests). Default 30000. */
  flushMs?: number;
  /** Injectable clock for deterministic UTC-day bucketing. */
  clock?: () => Date;
  /** Live epoch (UTC ms) for day-ordinal math — the chain-read anchor. Defaults to the
   *  hardcoded constant; a getter so a chain read that lands after boot is picked up. */
  epochMs?: () => number;
}

interface LedgerSnapshot {
  days: Record<string, LedgerCounters>;
}

const DEFAULT_FLUSH_MS = 30_000;
const FIELDS = [
  "petitions",
  "pondus",
  "transactions",
  "gasReserved",
  "failedTransactions",
  "wastedGasReserved",
] as const;

function zero(): LedgerCounters {
  return {
    petitions: 0,
    pondus: 0,
    transactions: 0,
    gasReserved: 0,
    failedTransactions: 0,
    wastedGasReserved: 0,
  };
}

/** Finite-and-positive guard → else 0. */
function nonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/**
 * The keyless **Pyth ledger** — Pythia's own running tally of the service she
 * provides, accumulated per UTC day. It only *counts* (petitions, tx) and *sums*
 * (pondus weight, reserved gas); it never signs or broadcasts. Per-day deltas are
 * kept so a future daily flush (the DALOS `A_Flush`, out of scope here) can read
 * them straight off; `total()` is the sum across all days. Persistence is atomic
 * (`.tmp` + rename) and non-fatal, modelled on `stats/store.ts`.
 */
export class PythLedger {
  private readonly filePath: string;
  private readonly clock: () => Date;
  private readonly days = new Map<string, LedgerCounters>();
  private readonly epochMs: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writeWarned = false;

  constructor(options: PythLedgerOptions) {
    this.filePath = options.filePath;
    this.clock = options.clock ?? (() => new Date());
    this.epochMs = options.epochMs ?? (() => PYTH_LEDGER_EPOCH_MS);
    this.loadFromDisk();

    const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    if (flushMs > 0) {
      this.timer = setInterval(() => this.persist(), flushMs);
      this.timer.unref?.();
    }
  }

  /** UTC "YYYY-MM-DD" today, per the injected clock. */
  today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private todayBucket(): LedgerCounters {
    const day = this.today();
    let d = this.days.get(day);
    if (!d) {
      d = zero();
      this.days.set(day, d);
    }
    return d;
  }

  /** A keyed read (or poll) served: +1 petition, + its pondus weight. */
  recordRead(pondusValue: number): void {
    const d = this.todayBucket();
    d.petitions += 1;
    d.pondus += nonNeg(pondusValue);
  }

  /** A relayed send of `count` txs (one batch shares one relay outcome):
   * accepted → +count transactions + gasLimit reserved; rejected → +count
   * failed-transactions + gasLimit wasted. */
  recordSend(accepted: boolean, gasLimit: number, count = 1): void {
    const g = nonNeg(gasLimit);
    const n = Number.isInteger(count) && count > 0 ? count : 1;
    const d = this.todayBucket();
    if (accepted) {
      d.transactions += n;
      d.gasReserved += g;
    } else {
      d.failedTransactions += n;
      d.wastedGasReserved += g;
    }
  }

  /** The running total across all days (pondus rounded to <=3 dp). */
  total(): LedgerCounters {
    const t = zero();
    for (const d of this.days.values()) {
      t.petitions += d.petitions;
      t.pondus += d.pondus;
      t.transactions += d.transactions;
      t.gasReserved += d.gasReserved;
      t.failedTransactions += d.failedTransactions;
      t.wastedGasReserved += d.wastedGasReserved;
    }
    t.pondus = round3(t.pondus);
    return t;
  }

  /** Per-day deltas ascending by day (pondus rounded) — ready for the Dalos flush. */
  daily(): DailyLedgerRow[] {
    return [...this.days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, c]) => ({ day, ...c, pondus: round3(c.pondus) }));
  }

  /** Distinct flushable (ordinal ≥ 1) day buckets currently held. The admin warns when
   *  this exceeds 2 — with a daily flush, a bigger backlog means flushes are failing. */
  unflushedDayCount(): number {
    const epoch = this.epochMs();
    let n = 0;
    for (const key of this.days.keys()) if (dayOrdinal(key, epoch) >= 1) n += 1;
    return n;
  }

  /**
   * Snapshot the current day-buckets into `entries[]` for one A_Flush, WITHOUT
   * mutating the ledger (the drain model: the live buckets keep accumulating; only a
   * confirmed on-chain success drains them via {@link commitFlush}). Oldest-first,
   * capped at `maxDays` (the rest wait for the next tick). Pre-epoch buckets (ordinal
   * < 1, not flushable on-chain) are excluded. `iz-complete` is true for any day before
   * today (sealed on this flush) and false for today (still open).
   */
  beginFlush(maxDays: number = MAX_FLUSH_BATCH): { entries: PythFlushEntry[]; token: FlushToken } {
    const epoch = this.epochMs();
    const todayOrd = dayOrdinal(this.today(), epoch);
    const keys = [...this.days.keys()]
      .filter((k) => dayOrdinal(k, epoch) >= 1)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, Math.max(0, maxDays));

    const entries: PythFlushEntry[] = [];
    const snapshot: Record<string, LedgerCounters> = {};
    for (const key of keys) {
      const c = this.days.get(key);
      if (!c) continue;
      snapshot[key] = { ...c };
      const ord = dayOrdinal(key, epoch);
      entries.push({
        day: ord,
        "iz-complete": ord < todayOrd,
        petitions: c.petitions,
        pondus: round3(c.pondus),
        transactions: c.transactions,
        "gas-reserved": c.gasReserved,
        "failed-transactions": c.failedTransactions,
        "wasted-gas-reserved": c.wastedGasReserved,
      });
    }
    return { entries, token: { days: snapshot } };
  }

  /**
   * The entries a flush would send RIGHT NOW — a side-effect-free snapshot for the admin
   * monitor (what goes on-chain if the flush fires). Same builder as {@link beginFlush},
   * without the drain token; never mutates the ledger.
   */
  previewEntries(): PythFlushEntry[] {
    return this.beginFlush().entries;
  }

  /**
   * Drain the amounts a {@link beginFlush} sent, called ONLY after the on-chain flush
   * confirmed success. Subtracts (never blindly deletes) so traffic that arrived between
   * snapshot and confirmation survives; a bucket that reaches zero is removed. Persists.
   */
  commitFlush(token: FlushToken): void {
    if (!token || typeof token !== "object" || !token.days) return;
    for (const [key, sent] of Object.entries(token.days)) {
      const live = this.days.get(key);
      if (!live) continue;
      live.petitions -= sent.petitions;
      live.pondus -= sent.pondus;
      live.transactions -= sent.transactions;
      live.gasReserved -= sent.gasReserved;
      live.failedTransactions -= sent.failedTransactions;
      live.wastedGasReserved -= sent.wastedGasReserved;
      const empty =
        live.petitions <= 0 &&
        live.pondus <= 0 &&
        live.transactions <= 0 &&
        live.gasReserved <= 0 &&
        live.failedTransactions <= 0 &&
        live.wastedGasReserved <= 0;
      if (empty) this.days.delete(key);
    }
    this.persist();
  }

  /** Reset the whole ledger to zero (the admin "nuke"). Persists immediately. */
  nuke(): void {
    this.days.clear();
    this.persist();
  }

  snapshot(): LedgerSnapshot {
    return { days: Object.fromEntries(this.days) };
  }

  private applySnapshot(snap: LedgerSnapshot): void {
    this.days.clear();
    if (snap && typeof snap === "object" && snap.days) {
      for (const [day, c] of Object.entries(snap.days)) {
        if (c && typeof c === "object") {
          const rec = c as unknown as Record<string, unknown>;
          const row = zero();
          for (const k of FIELDS) {
            const v = rec[k];
            if (typeof v === "number" && Number.isFinite(v)) row[k] = v;
          }
          this.days.set(day, row);
        }
      }
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.applySnapshot(
        JSON.parse(readFileSync(this.filePath, "utf8")) as LedgerSnapshot,
      );
    } catch {
      console.warn(
        `Pyth ledger at ${this.filePath} is unreadable/corrupt — starting empty`,
      );
    }
  }

  /** Atomically persist the snapshot. Non-fatal: warns once on failure. */
  persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot()), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      if (!this.writeWarned) {
        this.writeWarned = true;
        console.warn(
          `Pyth ledger flush to ${this.filePath} failed — continuing in-memory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Stop the persist timer (graceful shutdown). Call persist() first. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
