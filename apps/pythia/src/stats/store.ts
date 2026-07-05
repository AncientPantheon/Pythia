import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** The three operational verbs analytics counts. Health/connectors/static are
 * excluded — health is polled every 15s and would swamp real usage. */
export type StatsEndpoint = "read" | "send" | "poll";

export interface RecordInput {
  consumer: string;
  chain: string;
  endpoint: StatsEndpoint;
  /** true when the response status was < 400. */
  ok: boolean;
  /** UTC "YYYY-MM-DD" the request landed on. */
  day: string;
}

export interface StatsStoreOptions {
  /** Where the JSON snapshot is persisted. */
  filePath: string;
  /** Flush interval in ms. 0 disables the timer (tests). Default 30000. */
  flushMs?: number;
  /** Injectable clock for deterministic UTC-day computation. */
  clock?: () => Date;
}

export interface DailyView {
  day: string;
  requests: number;
  read: number;
  send: number;
  poll: number;
}

export interface StatsViews {
  since: string | null;
  generatedAt: string;
  totals: {
    requests: number;
    read: number;
    send: number;
    poll: number;
    errors: number;
  };
  byChain: Record<string, number>;
  byConsumer: Record<string, number>;
  daily: DailyView[];
}

export interface StatsSnapshot {
  since: string | null;
  counts: Record<string, number>;
}

const DEFAULT_FLUSH_MS = 30_000;
/** The daily series is capped so the /stats payload stays small even after years. */
const MAX_DAILY = 90;

/** Bucket key: day|consumer|chain|endpoint|ok. `ok` is "1" (<400) or "0". */
function bucketKey(r: RecordInput): string {
  return `${r.day}|${r.consumer}|${r.chain}|${r.endpoint}|${r.ok ? "1" : "0"}`;
}

function utcDay(clock: () => Date): string {
  return clock().toISOString().slice(0, 10);
}

/** Add whole UTC days to a "YYYY-MM-DD" string, returning the same format. */
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * In-memory usage-analytics aggregate with atomic JSON-snapshot persistence.
 *
 * Stores AGGREGATES ONLY — a counter per `day|consumer|chain|endpoint|ok`
 * bucket, never per-request rows — so the footprint stays tiny (one row per
 * distinct combination per day). It is keyless: it only counts, it never signs
 * or broadcasts. Persistence is atomic (write `${filePath}.tmp`, then rename)
 * and non-fatal: a failed write warns once and the store keeps serving from
 * memory. A missing snapshot starts empty; a corrupt one warns and starts empty.
 */
export class StatsStore {
  private readonly filePath: string;
  private readonly clock: () => Date;
  private readonly counts = new Map<string, number>();
  private since: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writeWarned = false;

  constructor(options: StatsStoreOptions) {
    this.filePath = options.filePath;
    this.clock = options.clock ?? (() => new Date());
    this.loadFromDisk();

    const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    if (flushMs > 0) {
      this.timer = setInterval(() => this.flush(), flushMs);
      // Do not keep the process alive solely for the flush timer.
      this.timer.unref?.();
    }
  }

  /** UTC "YYYY-MM-DD" today, per the injected clock. */
  today(): string {
    return utcDay(this.clock);
  }

  /** Increment the bucket for one operational request. */
  record(input: RecordInput): void {
    const key = bucketKey(input);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (this.since === null || input.day < this.since) {
      this.since = input.day;
    }
  }

  /** Serialize the counter map + since marker for persistence. */
  snapshot(): StatsSnapshot {
    return { since: this.since, counts: Object.fromEntries(this.counts) };
  }

  /** Restore a store from a snapshot object (e.g. read from disk). */
  static fromSnapshot(
    snapshot: StatsSnapshot,
    options: StatsStoreOptions,
  ): StatsStore {
    const store = new StatsStore(options);
    store.applySnapshot(snapshot);
    return store;
  }

  private applySnapshot(snapshot: StatsSnapshot): void {
    this.counts.clear();
    this.since = null;
    if (snapshot && typeof snapshot === "object" && snapshot.counts) {
      for (const [key, value] of Object.entries(snapshot.counts)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          this.counts.set(key, value);
        }
      }
    }
    this.since =
      snapshot && typeof snapshot.since === "string" ? snapshot.since : null;
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as StatsSnapshot;
      this.applySnapshot(parsed);
    } catch {
      console.warn(
        `Stats snapshot at ${this.filePath} is unreadable/corrupt — starting with empty analytics`,
      );
    }
  }

  /** Atomically persist the snapshot. Non-fatal: warns once on failure. */
  flush(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot()), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      if (!this.writeWarned) {
        this.writeWarned = true;
        console.warn(
          `Stats snapshot flush to ${this.filePath} failed — continuing in-memory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Stop the flush timer (graceful shutdown). Call flush() first to persist. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Retention helper (unused by default): drop buckets strictly before a day. */
  pruneBefore(dayStr: string): void {
    for (const key of [...this.counts.keys()]) {
      const day = key.slice(0, key.indexOf("|"));
      if (day < dayStr) this.counts.delete(key);
    }
    if (this.since !== null && this.since < dayStr) {
      this.since = dayStr;
    }
  }

  /** Compute the aggregate views the /stats endpoint returns. */
  views(): StatsViews {
    const totals = { requests: 0, read: 0, send: 0, poll: 0, errors: 0 };
    const byChain: Record<string, number> = {};
    const byConsumer: Record<string, number> = {};
    const perDay = new Map<string, DailyView>();

    for (const [key, count] of this.counts) {
      const [day, consumer, chain, endpoint, ok] = key.split("|");
      totals.requests += count;
      totals[endpoint as StatsEndpoint] += count;
      if (ok === "0") totals.errors += count;

      byChain[chain] = (byChain[chain] ?? 0) + count;
      byConsumer[consumer] = (byConsumer[consumer] ?? 0) + count;

      const d =
        perDay.get(day) ??
        { day, requests: 0, read: 0, send: 0, poll: 0 };
      d.requests += count;
      d[endpoint as StatsEndpoint] += count;
      perDay.set(day, d);
    }

    return {
      since: this.since,
      generatedAt: this.clock().toISOString(),
      totals,
      byChain,
      byConsumer,
      daily: this.buildDaily(perDay),
    };
  }

  /**
   * Build the ascending daily series covering every day from `since` to today,
   * filling absent days with zeros so the graph shows real gaps, capped to the
   * most recent {@link MAX_DAILY} days.
   */
  private buildDaily(perDay: Map<string, DailyView>): DailyView[] {
    if (this.since === null) return [];
    const today = this.today();
    const series: DailyView[] = [];
    let cursor = this.since;
    // Guard against a since somehow after today (clock skew) — emit at least today.
    if (cursor > today) cursor = today;
    while (cursor <= today) {
      series.push(
        perDay.get(cursor) ??
          { day: cursor, requests: 0, read: 0, send: 0, poll: 0 },
      );
      cursor = addDays(cursor, 1);
    }
    return series.length > MAX_DAILY ? series.slice(-MAX_DAILY) : series;
  }
}
