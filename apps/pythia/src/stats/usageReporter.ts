import type { SlotUsageMeter, UsageWindow } from "./slotUsage.js";
import type { HubServiceClient, UsageReport } from "../hub/serviceClient.js";

const DEFAULT_INTERVAL_MS = 60_000;

export interface UsageReporterOptions {
  meter: SlotUsageMeter;
  /** The current hub client, or `null` when the hub is unconfigured. */
  client: () => HubServiceClient | null;
  /** The report-to-hub toggle (SettingsStore.reportEnabled). */
  reportEnabled: () => boolean;
  /** Report cadence in ms. Default 60s. */
  intervalMs?: number;
}

/** Map a drained window to the hub report, stamping pondusVersion:1 per slot. */
function toReport(w: UsageWindow): UsageReport {
  return {
    period: w.period,
    slots: w.slots.map((s) => ({
      id: s.id,
      operator: s.operator,
      keyedRequests: s.keyedRequests,
      anonRequests: s.anonRequests,
      ok: s.ok,
      keyedPondus: s.keyedPondus,
      pondusVersion: 1,
    })),
  };
}

/**
 * The **usage reporter** — the ~60s loop that drains the per-slot window and POSTs
 * it to the hub (the money path). It honors:
 *  - **the report toggle** — OFF drains-and-DISCARDS (the window advances but the
 *    span never mints; Pythia's own fleet ledger is separate and keeps counting);
 *  - **the window contract** — a POST failure keeps the SAME window and retries it
 *    unchanged next tick (idempotent per (period, slot) first-write-wins); an empty
 *    window is skipped; an unconfigured hub leaves the meter accumulating.
 * Keyless: it authenticates to the hub with the M2M HMAC; it never signs a tx.
 */
export class UsageReporter {
  private readonly meter: SlotUsageMeter;
  private readonly client: () => HubServiceClient | null;
  private readonly reportEnabled: () => boolean;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** A window that failed to POST — retried unchanged until it lands. */
  private pendingWindow: UsageReport | null = null;

  constructor(opts: UsageReporterOptions) {
    this.meter = opts.meter;
    this.client = opts.client;
    this.reportEnabled = opts.reportEnabled;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  async tick(): Promise<void> {
    const on = this.reportEnabled();
    const client = this.client();

    // Retry a previously-failed window FIRST, unchanged (idempotent). If reporting
    // was turned off since, drop it — that span must not mint.
    if (this.pendingWindow) {
      if (!on) {
        this.pendingWindow = null;
        return;
      }
      if (!client) return;
      try {
        await client.postUsage(this.pendingWindow);
        this.pendingWindow = null;
      } catch {
        /* keep it for the next tick */
      }
      return;
    }

    if (this.meter.isEmpty()) return;

    // OFF → drain-and-DISCARD: the window advances (contiguous) but nothing is
    // reported, so the off span never mints.
    if (!on) {
      this.meter.drain();
      return;
    }

    // Can't report without a configured hub — leave the meter accumulating.
    if (!client) return;

    const w = this.meter.drain();
    if (w.slots.length === 0) return; // empty window → skip
    const report = toReport(w);
    try {
      await client.postUsage(report);
    } catch {
      this.pendingWindow = report; // retry unchanged next tick
    }
  }

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
