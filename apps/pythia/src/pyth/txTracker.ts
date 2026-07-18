import type { PythLedger } from "./ledger.js";

/** A relayed tx awaiting its mined outcome. */
export interface PendingTx {
  requestKey: string;
  gasLimit: number;
}

/** Resolve a batch of request keys to their EXECUTION outcome. A key still in
 * the mempool (unmined) is simply ABSENT from the returned map. */
export type PollExecutionFn = (
  requestKeys: string[],
) => Promise<Map<string, { success: boolean; gas: number }>>;

export interface TxTrackerOptions {
  ledger: PythLedger;
  poll: PollExecutionFn;
  /** ms-epoch clock (injectable for deterministic timeout tests). */
  clock?: () => number;
  /** How long to wait for a tx to mine before timing it out (default 5 min). */
  maxAgeMs?: number;
  /** Poll-loop cadence when started (default 15s). */
  intervalMs?: number;
}

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * The **self-polling tx-outcome tracker** — the execution-level upgrade to send
 * metering. When a send is relay-accepted the meter hands its requestKeys here;
 * this tracker polls chainweb (keyless — a plain read) until each tx mines, then
 * records the REAL outcome into the ledger: a mined success is a Transaction with
 * its ACTUAL gas; a mined failure (revert) is a Failed transaction with its
 * actual wasted gas. A tx that never mines within `maxAgeMs` is timed out as
 * failed, charging the reserved gasLimit as wasted.
 *
 * It counts each tx EXACTLY ONCE (at resolution) — the meter does not count
 * accepted sends itself when a tracker is wired, so there is no double count.
 */
export class TxTracker {
  private readonly pending = new Map<string, { gasLimit: number; at: number }>();
  private readonly ledger: PythLedger;
  private readonly poll: PollExecutionFn;
  private readonly clock: () => number;
  private readonly maxAgeMs: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: TxTrackerOptions) {
    this.ledger = opts.ledger;
    this.poll = opts.poll;
    this.clock = opts.clock ?? (() => Date.now());
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** Enqueue relay-accepted txs (deduped by requestKey). */
  track(entries: PendingTx[]): void {
    const now = this.clock();
    for (const e of entries) {
      if (e && typeof e.requestKey === "string" && e.requestKey && !this.pending.has(e.requestKey)) {
        const g = Number.isFinite(e.gasLimit) && e.gasLimit > 0 ? e.gasLimit : 0;
        this.pending.set(e.requestKey, { gasLimit: g, at: now });
      }
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** One resolution pass: poll the pending keys, record any that mined, and time
   * out the stale. Best-effort — a transient poll error just retries next tick. */
  async tick(): Promise<void> {
    if (this.pending.size === 0) return;
    const keys = [...this.pending.keys()];
    let outcomes = new Map<string, { success: boolean; gas: number }>();
    try {
      outcomes = await this.poll(keys);
    } catch {
      // Transient (node/pool hiccup) — leave everything pending, retry next tick.
      outcomes = new Map();
    }
    for (const [rk, o] of outcomes) {
      if (!this.pending.has(rk)) continue;
      // Execution-level: success → a transaction + actual gas; failure → a failed
      // transaction + actual wasted gas.
      this.ledger.recordSend(o.success, o.gas);
      this.pending.delete(rk);
    }
    const now = this.clock();
    for (const [rk, p] of [...this.pending]) {
      if (now - p.at >= this.maxAgeMs) {
        // Never mined in time — charge the reserved limit as wasted, count failed.
        this.ledger.recordSend(false, p.gasLimit);
        this.pending.delete(rk);
      }
    }
  }

  /** Start the periodic resolution loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
