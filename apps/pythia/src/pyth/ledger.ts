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

export interface PythLedgerOptions {
  filePath: string;
  /** Persist interval in ms. 0 disables the timer (tests). Default 30000. */
  flushMs?: number;
  /** Injectable clock for deterministic UTC-day bucketing. */
  clock?: () => Date;
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private writeWarned = false;

  constructor(options: PythLedgerOptions) {
    this.filePath = options.filePath;
    this.clock = options.clock ?? (() => new Date());
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

  /** A relayed send: accepted → +1 transaction + gasLimit reserved; rejected →
   * +1 failed-transaction + gasLimit wasted. */
  recordSend(accepted: boolean, gasLimit: number): void {
    const g = nonNeg(gasLimit);
    const d = this.todayBucket();
    if (accepted) {
      d.transactions += 1;
      d.gasReserved += g;
    } else {
      d.failedTransactions += 1;
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
