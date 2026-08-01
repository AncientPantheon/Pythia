import { DualLinkConnector, DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";
import type { DualLinkHalfStatus } from "@ancientpantheon/pythia-client";
import type { SelfApolloVault } from "./selfApollo.js";

/** Matches the ephemeral secret's own TTL (`EphemeralKeyStore`, Topic 1) — a
 * refresh well inside that window keeps both halves' secrets perpetually
 * fresh without hammering the verify route. */
const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000;

export interface SelfConnectorLoopOptions {
  /** Required by `Transport`'s constructor; NEVER actually dialed — `fetchImpl`
   * below (the in-process shortcut) is the real transport. */
  baseUrl: string;
  fetchImpl: typeof fetch;
  vault: SelfApolloVault;
  /** Refresh cadence in ms. Default 3h — see {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
}

export type SelfConnectorHalfStatus =
  | { status: "not-generated" }
  | { status: "not-linked" }
  | { status: "pending" }
  | { status: "active"; secret: string; expiresAt: number };

type Half = "standard" | "smart";

/**
 * Pythia consuming her OWN connector protocol on her OWN behalf: wraps a
 * single internal `DualLinkConnector` (`@ancientpantheon/pythia-client`,
 * Topic 1/`pythia-client-dual-link-sdk`) — the SAME generic mechanism any
 * other dual-link consumer (e.g. a future Mnemosyne) will drive — over
 * Pythia's own Standard + Smart Apollo halves (see `selfApollo.ts`), driven
 * by a `usageReporter.ts`-shaped periodic loop instead of a request-time
 * `keyProvider()` closure, since nothing calls Pythia's own `PythiaClient` on
 * a schedule the way an external consumer would.
 *
 * Lives under `automaton/` (not `connectors/self/`, despite the design doc's
 * original path) because it drives real Apollo signing through `vault`
 * (`createSigner`) — the keyless invariant's one carve-out
 * (`invariants/keylessScanner.ts`'s `AUTOMATON_CORE_DIR`), same as
 * `selfApollo.ts` itself.
 */
export class SelfConnectorLoop {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly vault: SelfApolloVault;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Lazily built, once BOTH of the vault's own accounts exist — then reused
   * across every subsequent tick, never rebuilt. `null` means the vault's
   * accounts don't both exist yet (nothing to do).
   *
   * Deliberately gated on `vault.standardAccount()`/`smartAccount()`, NOT on
   * `vault.dualLinkKey()` (the operator-pasted confirmation): unlike an
   * arbitrary external consumer, `SelfApolloVault` always deterministically
   * knows both of its own halves the moment they're generated, so it never
   * needs to be TOLD its own dual-link-key — it can always derive
   * `standard + DUAL_LINK_BAR + smart` itself. Gating construction on a
   * paste instead (an earlier version of this class did exactly that) broke
   * a real, already-shipped capability: proving ownership of a NOT-YET-linked
   * pair to feed `PendingActivationTracker` (see
   * `docs/work/connector-activation-resolver/`, `selfConnectorIntegration.
   * test.ts`) — that flow ticks immediately after generation, well before
   * any pair is linked or any key exists to paste. `setDualLinkKey()`
   * remains a genuinely useful operator-facing confirmation/validation
   * action (the admin panel echoes it, and a mismatched paste is rejected
   * immediately) — it just isn't a PREREQUISITE for this loop's own ticking. */
  private dualLinkConnector: DualLinkConnector | null = null;

  constructor(options: SelfConnectorLoopOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.vault = options.vault;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * If no internal `DualLinkConnector` exists yet, attempts to lazily build
   * one from the vault's own two accounts (self-derived key — see the
   * `dualLinkConnector` field's doc comment for why this doesn't wait on a
   * paste): either account still missing means still nothing to do (a
   * no-op). Once a connector exists (this call or a prior one), delegates to
   * its own `tick()` — per-half error isolation is `DualLinkConnector`'s own
   * job from here on.
   */
  async tick(): Promise<void> {
    if (!this.dualLinkConnector) {
      const standardAccount = this.vault.standardAccount();
      const smartAccount = this.vault.smartAccount();
      if (!standardAccount || !smartAccount) return; // not both generated yet — nothing to do
      try {
        this.dualLinkConnector = new DualLinkConnector({
          dualLinkKey: `${standardAccount}${DUAL_LINK_BAR}${smartAccount}`,
          baseUrl: this.baseUrl,
          standardSigner: this.vault.createSigner("standard"),
          smartSigner: this.vault.createSigner("smart"),
          fetchImpl: this.fetchImpl,
          intervalMs: this.intervalMs,
        });
      } catch (error) {
        // `DualLinkConnector`'s constructor calls `splitDualLinkKey`, which
        // throws on a malformed composite key. The self-derived key here
        // should always be well-formed (both halves come straight from
        // `Apollo.generateRandom()`'s own output shape), but this is reached
        // from `start()`'s `setInterval(() => { void this.tick(); }, ...)` —
        // an uncaught throw here would become an unhandled promise
        // rejection, same failure mode `DualLinkConnector.tickHalf`'s own
        // `onError` double-guard exists to prevent one layer down. Log and
        // leave `dualLinkConnector` null so a later tick can retry, rather
        // than crash the loop (or the process) outright.
        console.error("self-connector-loop: failed to construct the internal DualLinkConnector —", error);
        return;
      }
    }
    await this.dualLinkConnector.tick();
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

  /**
   * Reads the cached per-half status WITHOUT triggering any new network/
   * signer call. `"not-generated"` covers "the account doesn't exist yet"
   * (checked live against `vault`); `"not-linked"` covers "the account
   * exists, but `tick()` has never run yet" (so no internal
   * `DualLinkConnector` has ever been built — see that field's doc comment:
   * this is no longer gated on a pasted key, just on having ticked at least
   * once); once a connector exists, its own cached `DualLinkHalfStatus`
   * (`"pending"`/`"active"`) passes through.
   */
  status(): { standard: SelfConnectorHalfStatus; smart: SelfConnectorHalfStatus } {
    return {
      standard: this.halfStatus("standard", this.vault.standardAccount()),
      smart: this.halfStatus("smart", this.vault.smartAccount()),
    };
  }

  private halfStatus(which: Half, account: string | null): SelfConnectorHalfStatus {
    if (!account) return { status: "not-generated" };
    if (!this.dualLinkConnector) return { status: "not-linked" };
    return this.mapHalfStatus(
      which === "standard" ? this.dualLinkConnector.status().standard : this.dualLinkConnector.status().smart,
    );
  }

  private mapHalfStatus(half: DualLinkHalfStatus): SelfConnectorHalfStatus {
    return half.status === "active"
      ? { status: "active", secret: half.secret, expiresAt: half.expiresAt }
      : { status: "pending" };
  }
}
