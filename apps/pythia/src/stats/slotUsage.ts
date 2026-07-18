import { round3 } from "../pyth/pondus.js";

/** One slot's usage in the current window — the shape the hub's usage report
 * expects per slot (§4.3 of docs/HANDOFF-pythia-side-buildout.md + the pondus
 * handoff). `id` echoes the feed's slot id byte-identically; `operator` is
 * provenance (the reward join is on `id`). */
export interface SlotUsageRow {
  id: string;
  operator: string | null;
  /** Reads from a registered connector key (the ONLY ones that earn). */
  keyedRequests: number;
  /** Anonymous reads (metered, never earn). */
  anonRequests: number;
  /** COUNT of successful reads (NOT a 0/1 flag). */
  ok: number;
  /** Sum of PONDUS_V1 over the KEYED reads only (≤3 dp). */
  keyedPondus: number;
}

export interface UsageWindow {
  period: { from: string; to: string };
  slots: SlotUsageRow[];
}

interface SlotAcc {
  operator: string | null;
  keyedRequests: number;
  anonRequests: number;
  ok: number;
  keyedPondus: number;
}

/**
 * The **per-slot windowed usage meter** — the money path's accumulator. It counts
 * only READS served by HUB slots (the reporter passes the served slot id +
 * operator; Upload-Pool/seed reads never reach here). Each `drain()` closes the
 * current window (returns `{period, slots}`) and starts the NEXT one where this
 * ended — so windows are **contiguous, non-overlapping, and immutable once
 * drained**, which the hub relies on to not over-attribute earnings. Keyless: it
 * only counts + sums.
 */
export class SlotUsageMeter {
  private readonly clock: () => Date;
  private windowStart: string;
  private readonly slots = new Map<string, SlotAcc>();

  constructor(opts: { clock?: () => Date } = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.windowStart = this.clock().toISOString();
  }

  /** Record one served hub-slot READ. `keyed` = a registered key; `ok` = the read
   * succeeded (HTTP <400); `pondus` = the read's PONDUS_V1 (added to keyedPondus
   * only when keyed). */
  record(
    slotId: string,
    operator: string | null,
    keyed: boolean,
    ok: boolean,
    pondus: number,
  ): void {
    let s = this.slots.get(slotId);
    if (!s) {
      s = { operator, keyedRequests: 0, anonRequests: 0, ok: 0, keyedPondus: 0 };
      this.slots.set(slotId, s);
    }
    s.operator = operator; // keep the latest feed snapshot
    if (keyed) {
      s.keyedRequests += 1;
      if (Number.isFinite(pondus) && pondus > 0) s.keyedPondus += pondus;
    } else {
      s.anonRequests += 1;
    }
    if (ok) s.ok += 1;
  }

  isEmpty(): boolean {
    return this.slots.size === 0;
  }

  /** Close the current window and open the next (contiguous). */
  drain(): UsageWindow {
    const to = this.clock().toISOString();
    const from = this.windowStart;
    const slots: SlotUsageRow[] = [...this.slots.entries()].map(([id, s]) => ({
      id,
      operator: s.operator,
      keyedRequests: s.keyedRequests,
      anonRequests: s.anonRequests,
      ok: s.ok,
      keyedPondus: round3(s.keyedPondus),
    }));
    this.slots.clear();
    this.windowStart = to;
    return { period: { from, to }, slots };
  }
}
