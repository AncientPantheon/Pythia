import type { SourceConfig } from "../config/index.js";
import { STOA_NETWORK } from "../dial/index.js";
import type { HubServiceClient, HubSlot } from "../hub/serviceClient.js";

/** The {primary, fallback} pair the two-host dial consumes for one read. */
export interface ReadPair {
  primary: SourceConfig;
  fallback: SourceConfig;
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
 * The live read-node pool: the hub's advertised usable slots (refreshed on a
 * ~60s poll) with Pythia's checked-in seed nodes as the always-present fallback.
 *
 * `pickReadPair()` rotates the PRIMARY leg across the hub fleet so reads spread
 * the load, and always sets the FALLBACK leg to a SEED so every read has a
 * known-good backstop even if the picked hub node just died (the dial's transport
 * failover then serves the seed). With no hub slots known (feed off, empty, or
 * unreachable) it degrades to rotating the two seeds — exactly today's behavior.
 *
 * Keyless: this only selects which hosts to dial; it never signs or holds keys.
 */
export class NodePool {
  private hubSlots: SourceConfig[] = [];
  private rot = 0;
  private lastRefreshOk = false;
  private lastRefreshError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly seeds: SourceConfig[];
  private client: HubServiceClient | null;
  private readonly refreshMs: number;

  constructor(opts: {
    seeds: SourceConfig[];
    client?: HubServiceClient | null;
    refreshMs?: number;
  }) {
    this.seeds = opts.seeds;
    this.client = opts.client ?? null;
    this.refreshMs = opts.refreshMs ?? 60_000;
  }

  /** Begin polling the hub feed. No-op when no client is configured (seed-only). */
  start(): void {
    if (!this.client || this.timer) return;
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.refreshMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
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
    if (client) this.start();
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
      this.lastRefreshOk = true;
      this.lastRefreshError = null;
    } catch (err) {
      this.lastRefreshOk = false;
      this.lastRefreshError = err instanceof Error ? err.message : String(err);
      console.error(`pythia pool: hub feed refresh failed — ${this.lastRefreshError}`);
    }
  }

  /** Count of hub slots currently in the pool (for boot logs / future directory). */
  hubSlotCount(): number {
    return this.hubSlots.length;
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
   * Choose the {primary, fallback} for one read. Primary rotates across the hub
   * fleet; fallback is always a seed. No hub slots → rotate the seeds.
   */
  pickReadPair(): ReadPair {
    const seeds = this.seeds;
    const n = this.hubSlots.length;
    const r = this.rot++;
    if (n === 0) {
      const primary = seeds[r % seeds.length];
      const fallback = seeds.length > 1 ? seeds[(r + 1) % seeds.length] : seeds[0];
      return { primary, fallback };
    }
    const primary = this.hubSlots[r % n];
    const fallback = seeds[r % seeds.length];
    return { primary, fallback };
  }
}
