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
  addedAt: string;
}

export class TxSenderStore {
  private senders: TxSender[] = [];
  private readonly filePath: string;

  constructor(opts: {
    filePath: string;
    /** Seed the pool on first run (empty file) so sends work before curation. */
    defaults?: Array<{ url: string; label: string }>;
  }) {
    this.filePath = opts.filePath;
    this.load();
    if (this.senders.length === 0 && opts.defaults && opts.defaults.length > 0) {
      for (const d of opts.defaults) this.insert(d.url, d.label);
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) this.senders = parsed as TxSender[];
    } catch {
      // Absent/invalid → empty; the defaults (if any) then seed it.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.senders, null, 2));
    renameSync(tmp, this.filePath);
  }

  private insert(url: string, label: string): TxSender {
    const sender: TxSender = {
      id: randomUUID(),
      url,
      label: label || url,
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    this.senders.push(sender);
    this.persist();
    return sender;
  }

  /** All senders (admin view), newest first. */
  list(): TxSender[] {
    return [...this.senders].reverse();
  }

  /** Add a sender (enabled). */
  add(input: { url: string; label: string }): TxSender {
    return this.insert(input.url, input.label);
  }

  /** Remove a sender by id. Returns whether one was removed. */
  remove(id: string): boolean {
    const before = this.senders.length;
    this.senders = this.senders.filter((s) => s.id !== id);
    if (this.senders.length === before) return false;
    this.persist();
    return true;
  }

  /** Enable/disable a sender. Returns whether one was updated. */
  setEnabled(id: string, enabled: boolean): boolean {
    const sender = this.senders.find((s) => s.id === id);
    if (!sender) return false;
    sender.enabled = enabled;
    this.persist();
    return true;
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
