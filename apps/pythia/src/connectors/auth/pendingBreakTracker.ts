/**
 * The operator-initiated DEACTIVATION ("API Break") queue — the counterpart to
 * `PendingActivationTracker`, but the trigger is an ancient-admin action, not a
 * proof event. An ancient admin selects an ACTIVE dual link on the Connectors
 * page; the admin route (`/admin/connectors/break`) records the target composite
 * `dual-link-key` here and fires the `dual-link-break` cronoton, whose resolver
 * (`dualLinkBreakResolver.ts`) drains this queue at fire time into the on-chain
 * `A_RevokeLink(dualAPI)` transaction.
 *
 * Snapshot-then-commit, mirroring `PendingActivationTracker`: `beginBreak()`
 * snapshots the oldest queued key WITHOUT removing it, and `commitBreak(token)` —
 * called by the resolver's `settle()` ONLY on a confirmed on-chain success —
 * removes exactly that one. A failed/unfired attempt never commits, so the same
 * key simply retries on the next fire.
 */
export interface PendingBreak {
  /** The composite `dual-link-key` (`standard || "|" || smart`) to revoke. */
  dualLinkKey: string;
  at: number;
}

export interface PendingBreakTrackerOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  clock?: () => number;
}

export class PendingBreakTracker {
  /** token → queued break. Insertion order = FIFO fire order. */
  private readonly queue = new Map<string, PendingBreak>();
  private readonly clock: () => number;
  private seq = 0;

  constructor(opts: PendingBreakTrackerOptions = {}) {
    this.clock = opts.clock ?? Date.now;
  }

  /** Enqueue a dual link for revocation. Deduped by key — recording the same key
   * twice is a no-op (one pending revoke per link). Returns the token (existing or
   * new). */
  recordBreak(dualLinkKey: string): string {
    for (const [token, b] of this.queue) {
      if (b.dualLinkKey === dualLinkKey) return token;
    }
    const token = `brk_${(this.seq += 1)}`;
    this.queue.set(token, { dualLinkKey, at: this.clock() });
    return token;
  }

  /** Whether any break is queued (the event-drive gate — mirrors
   * `PendingActivationTracker.hasReadyPair`). */
  hasPending(): boolean {
    return this.queue.size > 0;
  }

  pendingCount(): number {
    return this.queue.size;
  }

  /** Snapshot the oldest queued break WITHOUT removing it (removed only by
   * `commitBreak` on confirmed success, so a failed fire retries). `null` when the
   * queue is empty — the resolver then fires a no-op. */
  beginBreak(): { dualLinkKey: string; token: string } | null {
    for (const [token, b] of this.queue) {
      return { dualLinkKey: b.dualLinkKey, token };
    }
    return null;
  }

  /** Remove the committed break — called on a confirmed on-chain revoke. Unknown
   * tokens are ignored. */
  commitBreak(token: string): void {
    this.queue.delete(token);
  }
}
