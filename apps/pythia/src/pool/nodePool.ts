import type { SourceConfig } from "../config/index.js";
import { STOA_NETWORK, type DialNode } from "../dial/index.js";
import type { AdvertisedSlot, HubServiceClient, HubSlot } from "../hub/serviceClient.js";

/** The {primary, fallback} pair the two-host dial consumes for one read. */
export interface ReadPair {
  primary: DialNode;
  fallback: DialNode;
}

/**
 * Map a hub slot into `SourceConfig` shape. `role`/`chain` are INERT for the dial
 * (it reads only `.url` and `.id`) — filled only so the existing two-host dial is
 * consumed unchanged. This is what keeps `dial()` and its 15 dependents untouched.
 */
function slotToSource(slot: HubSlot): SourceConfig {
  return {
    id: slot.id,
    url: slot.url,
    role: "primary",
    chain: slot.networkId || STOA_NETWORK,
  };
}

/**
 * The live read-node pool (the Observation Pool): the hub's advertised usable
 * slots (refreshed on a ~60s poll), with the **Upload Pool** as the fallback.
 *
 * `pickReadPair()` rotates the PRIMARY leg across the hub fleet so reads spread
 * the load, and sets the FALLBACK leg to an Upload-Pool node so a dead hub node
 * fails over to a known-good operator node. When the hub feed is off/down (no
 * slots), reads are REDIRECTED entirely to the Upload Pool. There is no separate
 * config-seed tier — the Upload Pool is seeded from the config on first run.
 *
 * Keyless: this only selects which hosts to dial; it never signs or holds keys.
 */
export class NodePool {
  private hubSlots: SourceConfig[] = [];
  /** Every advertised slot from the last feed (incl. not-at-tip) — for the admin
   * node table only; the read path uses `hubSlots`. Cleared with the hub slots. */
  private advertised: AdvertisedSlot[] = [];
  /** slotId → operator (string, or null for a usable-but-unearning slot). Only
   * ids present here are hub slots; an absent id is an Upload-Pool/seed node. */
  private slotOperators = new Map<string, string | null>();
  private rot = 0;
  private lastRefreshOk = false;
  private lastRefreshError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private client: HubServiceClient | null;
  private readonly refreshMs: number;
  private readonly uploadNodes: () => DialNode[];
  private readonly clock: () => number;
  private readonly staleMs: number;
  private readonly minRefreshMs: number;
  private readonly maxRefreshMs: number;
  /** ms-epoch of the last SUCCESSFUL feed poll (0 = never). */
  private lastGoodAt = 0;
  /** The hub's advised next-poll delay (ms) from the last feed, or null. */
  private lastRefreshAfterMs: number | null = null;

  constructor(opts: {
    client?: HubServiceClient | null;
    refreshMs?: number;
    /** The Upload Pool's enabled nodes. This is the read pool's fallback and,
     * when the hub feed is off/down, the read pool ITSELF — there is no separate
     * config-seed tier (the Upload Pool is seeded from the config on first run). */
    uploadNodes?: () => DialNode[];
    /** Injected clock (ms epoch) for deterministic staleness tests. */
    clock?: () => number;
    /** Drop the last-good hub slots once the last SUCCESSFUL poll is this old, so
     * a de-listed node stops receiving reads after an outage. Default 3 min. */
    staleMs?: number;
    minRefreshMs?: number;
    maxRefreshMs?: number;
  }) {
    this.client = opts.client ?? null;
    this.refreshMs = opts.refreshMs ?? 60_000;
    this.uploadNodes = opts.uploadNodes ?? (() => []);
    this.clock = opts.clock ?? (() => Date.now());
    this.staleMs = opts.staleMs ?? 180_000;
    this.minRefreshMs = opts.minRefreshMs ?? 15_000;
    this.maxRefreshMs = opts.maxRefreshMs ?? 300_000;
  }

  /** The next-poll delay: the hub's advised `refreshAfter` from the last feed
   * (clamped to a sane min/max), or the default when the hub hasn't advised one. */
  nextPollDelayMs(): number {
    const advised = this.lastRefreshAfterMs ?? this.refreshMs;
    return Math.min(this.maxRefreshMs, Math.max(this.minRefreshMs, advised));
  }

  /** Begin polling the hub feed. No-op when no client is configured (the read
   * pool then serves from the Upload Pool). */
  start(): void {
    if (!this.client || this.running) return;
    this.running = true;
    // Self-rescheduling loop so the hub can TUNE the poll cadence via refreshAfter
    // (a fixed setInterval ignored it). `running` guards against rescheduling after
    // stop()/reconfigure() while a poll is in flight.
    const loop = async () => {
      await this.refreshNow();
      if (this.running && this.client) {
        this.timer = setTimeout(loop, this.nextPollDelayMs());
        this.timer.unref?.();
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Swap the hub client at runtime (the admin set/cleared the feed config in the
   * UI). Stops the current poller; if a client is given, starts polling again and
   * clears any stale slots so the next poll repopulates; if `null`, disables the
   * feed and drops to seed-only immediately.
   */
  reconfigure(client: HubServiceClient | null): void {
    this.stop();
    this.client = client;
    this.hubSlots = [];
    this.advertised = [];
    this.slotOperators.clear();
    if (client) this.start();
  }

  /** The operator attributed to a served node id: a string, `null` for a
   * usable-but-unearning hub slot, or `undefined` when the id is NOT a current
   * hub slot (an Upload-Pool/seed node — which never earns and is not reported). */
  operatorForSlot(id: string): string | null | undefined {
    if (!this.slotOperators.has(id)) return undefined;
    return this.slotOperators.get(id) ?? null;
  }

  /**
   * One feed poll. On ANY failure keeps the last-good hub slots (or none, which
   * makes `pickReadPair` fall back to seeds) — the read path never goes down
   * because the hub feed did.
   */
  async refreshNow(): Promise<void> {
    if (!this.client) {
      this.lastRefreshOk = false;
      this.lastRefreshError = null;
      return;
    }
    try {
      const feed = await this.client.fetchNodes();
      this.hubSlots = feed.slots.map(slotToSource);
      this.advertised = feed.advertised ?? [];
      this.slotOperators = new Map(feed.slots.map((s) => [s.id, s.operator ?? null]));
      this.lastGoodAt = this.clock();
      this.lastRefreshAfterMs = feed.refreshAfter > 0 ? feed.refreshAfter * 1000 : null;
      this.lastRefreshOk = true;
      this.lastRefreshError = null;
    } catch (err) {
      this.lastRefreshOk = false;
      this.lastRefreshError = err instanceof Error ? err.message : String(err);
      // TTL: once the last GOOD poll is too old, stop serving the frozen last-good
      // hub slots — a de-listed node must not keep receiving reads after an outage.
      // Reads fall back to the Upload Pool until the feed recovers.
      if (this.hubSlots.length > 0 && this.clock() - this.lastGoodAt >= this.staleMs) {
        this.hubSlots = [];
        this.advertised = [];
        this.slotOperators.clear();
      }
      console.error(`pythia pool: hub feed refresh failed — ${this.lastRefreshError}`);
    }
  }

  /** Count of hub slots currently in the pool (for boot logs / future directory). */
  hubSlotCount(): number {
    return this.hubSlots.length;
  }

  /** Every advertised slot from the last good feed (incl. not-at-tip), for the
   * admin node table. Empty when the feed is off/down. Read-only snapshot. */
  advertisedSlots(): AdvertisedSlot[] {
    return this.advertised;
  }

  /** Feed health for the admin bullet: whether a client is configured, whether
   * the last poll succeeded, its error (if any), and the live slot count. */
  feedHealth(): {
    configured: boolean;
    ok: boolean;
    error: string | null;
    slots: number;
  } {
    return {
      configured: this.client !== null,
      ok: this.lastRefreshOk,
      error: this.lastRefreshError,
      slots: this.hubSlots.length,
    };
  }

  /**
   * Choose the {primary, fallback} for one read, or `null` when there is nothing
   * to serve reads from (no hub slots AND an empty Upload Pool → the caller
   * returns 503).
   *
   * - **Hub feed live** (has slots): primary rotates across the hub fleet to
   *   spread load; fallback is an Upload-Pool node (or another hub slot if the
   *   Upload Pool is empty).
   * - **Hub feed off/down** (no slots): reads are REDIRECTED to the Upload Pool —
   *   both legs rotate across it.
   */
  pickReadPair(): ReadPair | null {
    const upload = this.uploadNodes();
    const hub = this.hubSlots;
    const r = this.rot++;

    if (hub.length > 0) {
      const primary = hub[r % hub.length];
      const fallback =
        upload.length > 0
          ? upload[r % upload.length]
          : hub.length > 1
            ? hub[(r + 1) % hub.length]
            : hub[0];
      return { primary, fallback };
    }
    // Feed off/down → serve reads from the Upload Pool.
    if (upload.length > 0) {
      const primary = upload[r % upload.length];
      const fallback =
        upload.length > 1 ? upload[(r + 1) % upload.length] : upload[0];
      return { primary, fallback };
    }
    return null;
  }
}
