import { isSmartApollo, isStandardApollo } from "../../routes/connectorVerify.js";

/** Sort a pair's two accounts into a stable, order-independent key — the SAME
 * pair recorded from either half first must converge on one pending entry.
 * Uses `JSON.stringify` of the sorted pair rather than a plain `join("|")`:
 * a joined-with-separator key is only collision-free if neither input can
 * ever contain the separator itself, which this function has no way to
 * guarantee about a chain-supplied `counterpart` string (CONFIRMED HIGH in
 * review — a malformed/crafted counterpart containing "|" could otherwise
 * collide with, and silently corrupt, an unrelated pending pair's key).
 * `JSON.stringify` escapes embedded quotes/separators, so two different
 * sorted pairs can never produce the same key regardless of content. */
function pairKey(a: string, b: string): string {
  return JSON.stringify([a, b].sort());
}

/** How long a half-proven pair may sit waiting for its other half before it's
 * swept. Generous relative to how quickly a legitimate consumer proving both
 * of its own halves is expected to complete (minutes, not hours), but bounded
 * so an abandoned or one-sided proof (e.g. someone proving ownership of an
 * account whose counterpart never proves, or repeatedly proving accounts
 * that never pair) doesn't accumulate in memory for the process lifetime. */
export const PENDING_ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** How long a pair's "this activated" record is retained after `commitActivation`
 * (a CONFIRMED on-chain success) so the browser verify flow can truthfully report
 * "activated" — distinct from a pair that was simply never recorded. Matched to the
 * verify session's proof lifetime (`PROVEN_TTL_MS`, 1h) so it stays reportable for
 * as long as the operator's proof is honoured. Bounded by TTL + {@link MAX_ACTIVATED}
 * so it can't grow without limit. It is NEVER inferred (only a real commit writes it),
 * which is what closes the "two independent per-account proofs falsely read as an
 * activated pair" hole (a never-recorded cross-pair reports "none", not "activated"). */
export const ACTIVATED_RETENTION_MS = 60 * 60 * 1000;
const MAX_ACTIVATED = 10000;

/** How long a fully-proven pair may be repeatedly offered by `beginActivation()`
 * without ever being committed before it's deprioritized behind any OTHER
 * ready pair (CONFIRMED HIGH in review — head-of-line blocking: since
 * `commitActivation` only ever fires on a confirmed on-chain success,
 * `beginActivation()` naively always returning the single globally-oldest
 * ready entry meant one pair whose on-chain activation never confirms — e.g.
 * a stale `dualLinkCache` read letting `recordProof` re-fire for a pair
 * that's already active on-chain — would sit at the head of the queue and
 * starve every other, unrelated, genuinely-pending pair for up to the full
 * 24h TTL). Generous relative to one resolver tick + on-chain confirmation
 * (seconds, not minutes) so a pair that's simply "about to confirm" isn't
 * prematurely bumped, while still bounding how long any other pair can be
 * blocked behind it. A "stuck" entry is never abandoned — see
 * `beginActivation()` — only deprioritized: it's still offered (and can
 * still be committed) whenever it's the only ready candidate. */
export const ACTIVATION_STUCK_GRACE_MS = 10 * 60 * 1000;

/** Bound total outstanding pending pairs so a party willing to deploy+link
 * many on-chain accounts (a real but non-zero cost — 500 STOA/half plus
 * linking) can't grow this map without limit over the 24h TTL window.
 * Mirrors `AuthNonceStore`'s `MAX_NONCES` bound. Eviction (when at capacity)
 * only ever targets a NOT-yet-fully-proven entry — a fully-proven, ready
 * pair is never dropped just to make room for a new half-proof. */
const MAX_PENDING = 10000;

interface PendingPair {
  accountA: string;
  accountB: string;
  provenA: boolean;
  provenB: boolean;
  /** Monotonic creation order, so `beginActivation()` can offer the OLDEST
   *  ready pair first. */
  order: number;
  /** Epoch ms after which this entry is swept, whether or not it ever
   *  became fully proven. */
  expiresAt: number;
  /** Epoch ms of the FIRST time `beginActivation()` ever offered this entry
   *  (fully-proven and unexpired), or `undefined` if it's never been
   *  offered yet. Purely a head-of-line-fairness signal — set the moment a
   *  ready entry is first returned, never reset, never affects proven
   *  state or removal. See {@link ACTIVATION_STUCK_GRACE_MS}. */
  firstOfferedAt: number | undefined;
}

export interface PendingActivationTrackerOptions {
  /** Injectable clock for deterministic expiry tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Sweep cadence for the background loop. Default 5 minutes. */
  sweepIntervalMs?: number;
  /** Cap on total outstanding pending pairs. Default {@link MAX_PENDING};
   * injectable so the eviction behavior is testable without actually
   * creating 10000 entries. */
  maxPending?: number;
}

/**
 * Pairs two independent per-half headless proofs (`connectorAuth.ts`'s
 * `/connectors/auth/verify` route, one Apollo half at a time) into one
 * ready-to-activate `DualLink` pair for the `dual-link-activate` Khronoton
 * resolver. Mirrors `PythLedger`'s beginFlush/commitFlush drain contract:
 * `beginActivation()` snapshots the oldest ready pair WITHOUT mutating
 * state; only a `commitActivation(token)` for a confirmed on-chain success
 * removes it. The token IS the pair's own key (opaque to callers, but
 * deterministic) — a token for a pair that either was never recorded or
 * isn't (yet) fully proven simply matches nothing, so committing it is a
 * no-op rather than a throw.
 *
 * Also mirrors `EphemeralKeyStore`'s TTL/sweep shape: an entry that never
 * becomes fully proven (an abandoned or one-sided proof) is not kept
 * forever — see `PENDING_ACTIVATION_TTL_MS`.
 */
export class PendingActivationTracker {
  private readonly pending = new Map<string, PendingPair>();
  /** pairKey → expiry (epoch ms) for pairs that were CONFIRMED-activated (a real
   * `commitActivation`). The authoritative source of the "activated" status —
   * never inferred. TTL'd + capped ({@link ACTIVATED_RETENTION_MS}/{@link MAX_ACTIVATED}). */
  private readonly activated = new Map<string, number>();
  private nextOrder = 0;
  private readonly clock: () => number;
  private readonly sweepIntervalMs: number;
  private readonly maxPending: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Event-driven activation hook: invoked the instant a pair transitions to
   * fully-proven (the "link event"), so a subscriber (the automaton engine) can
   * fire `A_LinkDualApiKey` IMMEDIATELY — no schedule, no tick, no polling. Set by
   * the composition root; undefined → the tracker just holds ready pairs (its
   * pre-event shape). Never imports the automaton core (it only calls a callback),
   * so the keyless request path that feeds `recordProof` stays keyless. */
  private onPairReady: (() => void) | undefined;

  constructor(opts: PendingActivationTrackerOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
  }

  /** Record that `apolloAccount` has proven ownership and is paired with
   * `counterpart` (the on-chain `UR_Counterpart` read). Order-independent:
   * calling this for the OTHER half of the same pair marks it ready.
   * `apolloAccount === counterpart` is a degenerate, self-referential call
   * (can never transition to fully-proven, since only one of `provenA`/
   * `provenB` could ever be set) — logged and ignored rather than left to
   * silently occupy the map inertly until its TTL sweep. */
  recordProof(apolloAccount: string, counterpart: string): void {
    if (apolloAccount === counterpart) {
      console.error(
        `pythia connector activation: ignoring self-referential proof for ${apolloAccount}`,
      );
      return;
    }
    const key = pairKey(apolloAccount, counterpart);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= this.maxPending) {
        const oldestUnproven = [...this.pending.entries()].find(
          ([, e]) => !(e.provenA && e.provenB),
        );
        if (oldestUnproven) this.pending.delete(oldestUnproven[0]);
        // If every entry is already fully proven, the map is full of
        // ready-to-activate pairs waiting on the resolver — don't drop any
        // of those; the new entry simply isn't added this call (the caller
        // can safely retry once the resolver drains some via commitActivation).
        else return;
      }
      const [accountA, accountB] = [apolloAccount, counterpart].sort();
      entry = {
        accountA,
        accountB,
        provenA: false,
        provenB: false,
        order: this.nextOrder++,
        expiresAt: this.clock() + PENDING_ACTIVATION_TTL_MS,
        firstOfferedAt: undefined,
      };
      this.pending.set(key, entry);
    }
    const wasFullyProven = entry.provenA && entry.provenB;
    if (apolloAccount === entry.accountA) entry.provenA = true;
    else entry.provenB = true;
    // Refresh the TTL the moment a pair TRANSITIONS to fully proven, so a
    // pair that completes late (close to the original first-proof TTL
    // boundary) still gets a full window to actually be picked up and drained
    // by the resolver, instead of expiring — silently, with no error surfaced
    // to either half's caller — before it's ever offered.
    if (!wasFullyProven && entry.provenA && entry.provenB) {
      entry.expiresAt = this.clock() + PENDING_ACTIVATION_TTL_MS;
      // THE LINK EVENT. A pair just became fully proven → fire activation NOW.
      // Wrapped so a subscriber error can never break the proof-recording path
      // (the pair stays ready and is retried on the next event regardless).
      try {
        this.onPairReady?.();
      } catch (err) {
        console.error("pythia connector activation: onPairReady hook threw:", err);
      }
    }
  }

  /** Subscribe to the link event (a pair becoming fully proven). Pass `undefined`
   * to unsubscribe. Set by the composition root to the automaton's immediate-fire. */
  setOnPairReady(cb: (() => void) | undefined): void {
    this.onPairReady = cb;
  }

  /** Whether ANY pair is ready to activate right now (both halves proven, unexpired)
   * — a PURE check (no mutation, no `firstOfferedAt`), so the event-driven trigger
   * can gate on it and never fire a blank `A_LinkDualApiKey` when nothing's queued. */
  hasReadyPair(): boolean {
    const now = this.clock();
    for (const entry of this.pending.values()) {
      if (entry.expiresAt > now && entry.provenA && entry.provenB) return true;
    }
    return false;
  }

  /** The OLDEST unexpired pair with both halves proven, WITHOUT removing it
   *  from pending state (nor marking it committed) — or `null` if none is
   *  ready yet. Among ready candidates, a "fresh" one (never offered, or
   *  offered less than {@link ACTIVATION_STUCK_GRACE_MS} ago) is always
   *  preferred over a "stuck" one (offered longer ago than that and STILL
   *  not committed — i.e. its on-chain activation never confirmed), so one
   *  permanently-failing pair can't starve every other ready pair for its
   *  whole TTL. A stuck entry is never abandoned outright: it's still
   *  offered — and can still be committed — whenever it's the only ready
   *  candidate, so a transient failure that later succeeds is still picked
   *  up. Within each tier, the oldest (`order`) wins, same as before. */
  beginActivation(): { pair: { standard: string; smart: string }; token: string } | null {
    const now = this.clock();
    let freshKey: string | null = null;
    let freshEntry: PendingPair | null = null;
    let stuckKey: string | null = null;
    let stuckEntry: PendingPair | null = null;
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) continue;
      if (!entry.provenA || !entry.provenB) continue;
      const isStuck =
        entry.firstOfferedAt !== undefined && now - entry.firstOfferedAt > ACTIVATION_STUCK_GRACE_MS;
      if (isStuck) {
        if (!stuckEntry || entry.order < stuckEntry.order) {
          stuckEntry = entry;
          stuckKey = key;
        }
      } else if (!freshEntry || entry.order < freshEntry.order) {
        freshEntry = entry;
        freshKey = key;
      }
    }
    const chosen = freshEntry ?? stuckEntry;
    const chosenKey = freshKey ?? stuckKey;
    if (!chosen || !chosenKey) return null;

    if (chosen.firstOfferedAt === undefined) chosen.firstOfferedAt = now;

    const standard = isStandardApollo(chosen.accountA) ? chosen.accountA : chosen.accountB;
    const smart = isSmartApollo(chosen.accountA) ? chosen.accountA : chosen.accountB;
    return { pair: { standard, smart }, token: chosenKey };
  }

  /** The activation state of a SPECIFIC pair (order-independent), for surfacing
   *  the outcome to an operator watching the browser verify flow:
   *   - `"activated"` — this pair was CONFIRMED-activated on-chain (a real
   *     `commitActivation`) within the retention window. Authoritative, never
   *     inferred from per-account proofs — so a never-recorded cross-pair reads
   *     `"none"`, not a false `"activated"`.
   *   - `"ready"` — both halves proven and the pair is still pending (queued for,
   *     or mid-, activation; `commitActivation` hasn't confirmed on-chain success),
   *   - `"half"` — recorded but only one half proven so far,
   *   - `"none"` — not tracked and not recently activated.
   * Read-only w.r.t. pending/offer state (only prunes its own expired activated
   * record on read); never sets `firstOfferedAt`. */
  statusOf(a: string, b: string): "none" | "half" | "ready" | "activated" {
    if (a === b) return "none";
    const key = pairKey(a, b);
    const activatedExpiry = this.activated.get(key);
    if (activatedExpiry !== undefined) {
      if (activatedExpiry > this.clock()) return "activated";
      this.activated.delete(key); // expired — fall through
    }
    const entry = this.pending.get(key);
    if (!entry) return "none";
    if (entry.expiresAt <= this.clock()) return "none";
    return entry.provenA && entry.provenB ? "ready" : "half";
  }

  /** Remove exactly the pair `token` was issued for, and RECORD it as activated
   *  (retained for {@link ACTIVATED_RETENTION_MS} so `statusOf` can report it). A
   *  stale/unknown token (or one for a pair that isn't fully proven) is a no-op,
   *  not a throw — and records nothing (only a real, fully-proven pair activates). */
  commitActivation(token: string): void {
    const entry = this.pending.get(token);
    if (!entry || !entry.provenA || !entry.provenB) return;
    this.pending.delete(token);
    if (this.activated.size >= MAX_ACTIVATED) {
      const oldest = this.activated.keys().next().value; // insertion-ordered
      if (oldest) this.activated.delete(oldest);
    }
    this.activated.set(token, this.clock() + ACTIVATED_RETENTION_MS);
  }

  /** Purge every expired entry (proven or not) AND every expired activated record.
   *  Returns the number removed. */
  sweepExpired(): number {
    const now = this.clock();
    let removed = 0;
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key);
        removed += 1;
      }
    }
    for (const [key, expiry] of this.activated) {
      if (expiry <= now) {
        this.activated.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweepExpired();
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
