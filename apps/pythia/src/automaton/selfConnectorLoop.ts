import { DualLinkConnector } from "@ancientpantheon/pythia-client";
import type { DualLinkHalfStatus } from "@ancientpantheon/pythia-client";
import type { SelfApolloVault } from "./selfApollo.js";

/** This class (unlike the published `DualLinkConnector` any other consumer
 * constructs, whose own `DEFAULT_INTERVAL_MS` stays 3h) has exactly ONE
 * construction site — Pythia's own self-connector (`index.ts`) — so its own
 * default IS Pythia's interval: 24h, matching her 24h ephemeral-secret TTL
 * (v2.6.0), not the 3h default other consumers' own `DualLinkConnector`
 * instances use. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SelfConnectorLoopOptions {
  /** Required by `Transport`'s constructor; NEVER actually dialed — `fetchImpl`
   * below (the in-process shortcut) is the real transport. */
  baseUrl: string;
  fetchImpl: typeof fetch;
  vault: SelfApolloVault;
  /** Refresh cadence in ms. Default 24h — see {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
}

export type SelfConnectorHalfStatus =
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

  /** Lazily built, once `vault.dualLinkKey()` is set — then reused across
   * every subsequent tick, never rebuilt. `null` means no key has been
   * pasted yet (nothing to do).
   *
   * Gated on `vault.dualLinkKey()` (the operator-pasted confirmation), NOT on
   * the vault's own account getters independently: `SelfApolloVault` no
   * longer generates or otherwise discovers its own accounts (`docs/work/
   * self-connector-codex-signing/design.md`) — `standardAccount()`/
   * `smartAccount()` are themselves DERIVED from `dualLinkKey()` now, so
   * there is no account knowledge independent of an explicitly pasted key
   * for this gate to check separately. This is a deliberate REVERSION of a
   * prior redesign (`self-connector-dual-link`) that gated construction on
   * the vault's own accounts specifically so this loop could prove ownership
   * of a NOT-YET-linked pair ahead of a paste — that capability is retired
   * along with local generation (see `selfConnectorIntegration.test.ts`'s
   * doc comment for the retirement rationale); the paste is now the ONLY
   * source of truth. */
  private dualLinkConnector: DualLinkConnector | null = null;

  constructor(options: SelfConnectorLoopOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.vault = options.vault;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * If no internal `DualLinkConnector` exists yet, attempts to lazily build
   * one from the vault's own pasted `dualLinkKey()` (see the
   * `dualLinkConnector` field's doc comment for why this waits on a paste):
   * no key yet means still nothing to do (a no-op). Once a connector exists
   * (this call or a prior one), delegates to its own `tick()` — per-half
   * error isolation is `DualLinkConnector`'s own job from here on.
   */
  async tick(): Promise<void> {
    if (!this.dualLinkConnector) {
      const dualLinkKey = this.vault.dualLinkKey();
      if (!dualLinkKey) return; // no dual-link-key pasted yet — nothing to do
      try {
        this.dualLinkConnector = new DualLinkConnector({
          dualLinkKey,
          baseUrl: this.baseUrl,
          standardSigner: this.vault.createSigner("standard"),
          smartSigner: this.vault.createSigner("smart"),
          fetchImpl: this.fetchImpl,
          intervalMs: this.intervalMs,
        });
      } catch (error) {
        // `DualLinkConnector`'s constructor calls `splitDualLinkKey`, which
        // throws on a malformed composite key. `setDualLinkKey` already
        // validates the key before sealing it, so a malformed key should
        // never be reachable here in practice — but this is reached from
        // `start()`'s `setInterval(() => { void this.tick(); }, ...)`, and an
        // uncaught throw here would become an unhandled promise rejection,
        // same failure mode `DualLinkConnector.tickHalf`'s own `onError`
        // double-guard exists to prevent one layer down. Log and leave
        // `dualLinkConnector` null so a later tick can retry, rather than
        // crash the loop (or the process) outright — defense-in-depth.
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
   * signer call. `"not-linked"` covers "no dual-link-key has been pasted
   * yet, or `tick()` has never run" (no internal `DualLinkConnector` has
   * ever been built); once a connector exists, its own cached
   * `DualLinkHalfStatus` (`"pending"`/`"active"`) passes through.
   */
  status(): { standard: SelfConnectorHalfStatus; smart: SelfConnectorHalfStatus } {
    return {
      standard: this.halfStatus("standard"),
      smart: this.halfStatus("smart"),
    };
  }

  private halfStatus(which: Half): SelfConnectorHalfStatus {
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
