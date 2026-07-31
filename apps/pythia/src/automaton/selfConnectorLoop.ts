import { PythiaConnector } from "@ancientpantheon/pythia-client";
import type { ConnectorSecretResult } from "@ancientpantheon/pythia-client";
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
  | { status: "pending" }
  | { status: "active"; secret: string; expiresAt: number };

type Half = "standard" | "smart";

/**
 * Pythia consuming her OWN connector protocol on her OWN behalf: one
 * `PythiaConnector` per Apollo half (Standard + Smart — see `selfApollo.ts`),
 * driven by a `usageReporter.ts`-shaped periodic loop instead of a
 * request-time `keyProvider()` closure, since nothing calls Pythia's own
 * `PythiaClient` on a schedule the way an external consumer would.
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

  /** Lazily built, then reused across every subsequent tick — never rebuilt. */
  private standardConnector: PythiaConnector | null = null;
  private smartConnector: PythiaConnector | null = null;

  /** The last successful `ensureSecret()` result per half, or `null` when no
   * tick has yet succeeded for it — `status()` reads these without ever
   * triggering a network/signer call of its own. */
  private lastStandard: ConnectorSecretResult | null = null;
  private lastSmart: ConnectorSecretResult | null = null;

  constructor(options: SelfConnectorLoopOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.vault = options.vault;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Runs both halves independently: a half whose account doesn't exist yet
   * is skipped entirely (no connector, no cached-status change); a half
   * whose `ensureSecret()` throws is caught and logged HERE so it can never
   * prevent the other half's tick from running, nor throw out of `tick()`
   * itself — mirrors `usageReporter.tick()`'s per-branch isolation.
   */
  async tick(): Promise<void> {
    await this.tickHalf("standard");
    await this.tickHalf("smart");
  }

  private async tickHalf(which: Half): Promise<void> {
    const account = which === "standard" ? this.vault.standardAccount() : this.vault.smartAccount();
    if (!account) return; // that half hasn't been generated — nothing to do

    try {
      const connector = this.connectorFor(which, account);
      const result = await connector.ensureSecret();
      if (which === "standard") this.lastStandard = result;
      else this.lastSmart = result;
    } catch (error) {
      console.error(`self-connector-loop: the "${which}" half's tick failed —`, error);
      // Leave that half's cached status unchanged — the other half's tick
      // (already run, or about to run) is unaffected.
    }
  }

  private connectorFor(which: Half, account: string): PythiaConnector {
    const existing = which === "standard" ? this.standardConnector : this.smartConnector;
    if (existing) return existing;
    const connector = new PythiaConnector({
      baseUrl: this.baseUrl,
      apolloAccount: account,
      signer: this.vault.createSigner(which),
      fetchImpl: this.fetchImpl,
    });
    if (which === "standard") this.standardConnector = connector;
    else this.smartConnector = connector;
    return connector;
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
   * signer call. `"not-generated"` covers both "the account doesn't exist
   * yet" (checked live against `vault`) and "no tick has ever succeeded for
   * it yet" — either way there is nothing else to report.
   */
  status(): { standard: SelfConnectorHalfStatus; smart: SelfConnectorHalfStatus } {
    return {
      standard: this.halfStatus("standard"),
      smart: this.halfStatus("smart"),
    };
  }

  private halfStatus(which: Half): SelfConnectorHalfStatus {
    const account = which === "standard" ? this.vault.standardAccount() : this.vault.smartAccount();
    if (!account) return { status: "not-generated" };
    const cached = which === "standard" ? this.lastStandard : this.lastSmart;
    return cached ?? { status: "not-generated" };
  }
}
