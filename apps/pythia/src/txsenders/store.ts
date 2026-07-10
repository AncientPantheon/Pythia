import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DialNode } from "../dial/index.js";

/**
 * The **Upload Pool** — the manual, ancient-managed list of dedicated nodes that
 * signed transactions (`/stoachain/send`) are relayed to, and ONLY these. Reads
 * never touch this pool (they use the hub-fed Observation Pool), and these nodes
 * earn NO PythXP — sends are never metered as usage. Predictable tx delivery is
 * the point: an empty Upload Pool fails a send with 503 rather than silently
 * routing a signed tx to a read node.
 *
 * File-backed on the mounted volume, atomic temp+rename (modelled on
 * `connectors/store.ts`). Optionally seeded with defaults on first run so sends
 * keep working out of the box until the admin curates dedicated senders.
 */
export interface TxSender {
  id: string;
  url: string;
  label: string;
  enabled: boolean;
  /** A baked-in SEED node (from the checked-in config). Always present, cannot be
   * removed by the admin — it guarantees Pythia works from deployment (serving
   * sends and read-fallback), even before the admin curates anything. */
  seed: boolean;
  addedAt: string;
}

/** Outcome of a remove() — distinguishes a protected seed node from a miss. */
export type RemoveResult = "removed" | "protected" | "not-found";

/** Outcome of a setEnabled() — seeds are permanent AND permanently enabled, so
 * any toggle on a seed is `protected` (refused), keeping the baseline serving
 * guarantee intact. */
export type SetEnabledResult = "updated" | "protected" | "not-found";

export class TxSenderStore {
  private senders: TxSender[] = [];
  private readonly filePath: string;

  constructor(opts: {
    filePath: string;
    /** The baked-in seed nodes (from config). Reconciled on EVERY boot: ensured
     * present and tagged `seed`, so they can never be lost or removed. */
    seeds?: Array<{ url: string; label: string }>;
  }) {
    this.filePath = opts.filePath;
    this.load();
    this.reconcileSeeds(opts.seeds ?? []);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) {
        this.senders = (parsed as TxSender[]).map((s) => ({ ...s, seed: !!s.seed }));
      }
    } catch {
      // Absent/invalid → empty; reconcileSeeds then bakes the seeds in.
    }
  }

  /** Ensure every configured seed exists and is tagged `seed` (permanent). */
  private reconcileSeeds(seeds: Array<{ url: string; label: string }>): void {
    let changed = false;
    for (const s of seeds) {
      const existing = this.senders.find((x) => x.url === s.url);
      if (existing) {
        if (!existing.seed) {
          existing.seed = true;
          changed = true;
        }
      } else {
        this.senders.push({
          id: randomUUID(),
          url: s.url,
          label: s.label || s.url,
          enabled: true,
          seed: true,
          addedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.senders, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** All senders (admin view). Seeds first, then admin-added newest-first. */
  list(): TxSender[] {
    const seeds = this.senders.filter((s) => s.seed);
    const added = this.senders.filter((s) => !s.seed).reverse();
    return [...seeds, ...added];
  }

  /** Add an admin sender (enabled, not a seed). */
  add(input: { url: string; label: string }): TxSender {
    const sender: TxSender = {
      id: randomUUID(),
      url: input.url,
      label: input.label || input.url,
      enabled: true,
      seed: false,
      addedAt: new Date().toISOString(),
    };
    this.senders.push(sender);
    this.persist();
    return sender;
  }

  /** Remove a sender by id. SEED nodes are protected (cannot be removed). */
  remove(id: string): RemoveResult {
    const sender = this.senders.find((s) => s.id === id);
    if (!sender) return "not-found";
    if (sender.seed) return "protected";
    this.senders = this.senders.filter((s) => s.id !== id);
    this.persist();
    return "removed";
  }

  /**
   * Enable/disable an ADMIN sender. SEED nodes are permanently enabled and
   * cannot be toggled (`protected`) — they guarantee Pythia keeps serving sends
   * and read-fallback from deployment, so they must never be switched off.
   */
  setEnabled(id: string, enabled: boolean): SetEnabledResult {
    const sender = this.senders.find((s) => s.id === id);
    if (!sender) return "not-found";
    if (sender.seed) return "protected";
    sender.enabled = enabled;
    this.persist();
    return "updated";
  }

  /**
   * The enabled senders, in add order, as dial nodes — the exact ordered list the
   * Upload lane tries "one after the other". Empty when none are enabled (the
   * caller then returns 503, never falling back to read/seed nodes).
   */
  enabledNodes(): DialNode[] {
    return this.senders
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, url: s.url }));
  }
}
