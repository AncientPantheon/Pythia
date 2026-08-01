import { PythiaConnector, type ApolloSigner, type ConnectorSecretResult } from "./connector.js";
import { splitDualLinkKey } from "./dualLinkKey.js";

/** Matches `PythiaConnector`'s own refresh-margin assumption — a refresh well
 * inside a secret's TTL keeps both halves' secrets perpetually fresh without
 * hammering the verify route. */
const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000;

type Half = "standard" | "smart";

export type DualLinkHalfStatus =
  | { status: "pending" }
  | { status: "active"; secret: string; expiresAt: number };

export interface DualLinkConnectorOptions {
  /** Split via `splitDualLinkKey` at construction — a malformed key throws
   * synchronously, before anything else is constructed. */
  dualLinkKey: string;
  baseUrl: string;
  standardSigner: ApolloSigner;
  smartSigner: ApolloSigner;
  fetchImpl?: typeof fetch;
  /** Refresh cadence in ms. Default 3h — see {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Called when a half's `ensureSecret()` throws during `tick()` — not just
   * this SDK's own `PythiaConnectorError`s, but also whatever your injected
   * `standardSigner`/`smartSigner` throw (mirrors `PythiaConnectorOptions.
   * onKeyProviderError`'s identical caveat). Defaults to `console.error`.
   * This callback is itself called inside a try/catch (see `tickHalf`) — if
   * you wire it to a logging/APM sink that can throw (e.g. a network-backed
   * logger), that throw is caught and reported via a SECOND, fixed
   * `console.error` fallback rather than propagating, so a misbehaving
   * `onError` can never break the other half's tick or crash the `start()`
   * interval loop via an unhandled rejection. */
  onError?: (half: Half, error: unknown) => void;
}

export interface DualLinkStatus {
  standard: DualLinkHalfStatus;
  smart: DualLinkHalfStatus;
  /** Whichever half currently has an active secret — standard preferred,
   * smart as fallback — since the gate never cares which half issued it.
   * `null` when neither half is active. */
  secret: string | null;
  expiresAt: number | null;
}

/**
 * The class-shaped generalization of `apps/pythia`'s `SelfConnectorLoop`
 * pattern for an arbitrary already-active dual-link pair: holds two internal
 * `PythiaConnector`s (one per Apollo half), ticks both on a schedule with
 * per-half error isolation, and reports one usable status object — both
 * halves' individual state, plus a single `secret`/`expiresAt` a consumer can
 * use directly. See `docs/work/pythia-client-dual-link-sdk/design.md`.
 */
export class DualLinkConnector {
  private readonly standardConnector: PythiaConnector;
  private readonly smartConnector: PythiaConnector;
  private readonly intervalMs: number;
  private readonly onError: (half: Half, error: unknown) => void;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** The last successful `ensureSecret()` result per half — `{status:
   * "pending"}` until the first tick succeeds for that half. */
  private lastStandard: ConnectorSecretResult = { status: "pending" };
  private lastSmart: ConnectorSecretResult = { status: "pending" };

  constructor(options: DualLinkConnectorOptions) {
    const { standardApollo, smartApollo } = splitDualLinkKey(options.dualLinkKey);
    this.standardConnector = new PythiaConnector({
      baseUrl: options.baseUrl,
      apolloAccount: standardApollo,
      signer: options.standardSigner,
      fetchImpl: options.fetchImpl,
    });
    this.smartConnector = new PythiaConnector({
      baseUrl: options.baseUrl,
      apolloAccount: smartApollo,
      signer: options.smartSigner,
      fetchImpl: options.fetchImpl,
    });
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onError =
      options.onError ??
      ((half, error) =>
        console.error(`dual-link-connector: the "${half}" half's tick failed —`, error));
  }

  /**
   * Runs both halves independently: a half whose `ensureSecret()` throws is
   * caught and reported via `onError` HERE so it can never prevent the other
   * half's tick from running, nor throw out of `tick()` itself — mirrors
   * `SelfConnectorLoop.tick()`'s per-half isolation exactly.
   */
  async tick(): Promise<void> {
    await this.tickHalf("standard");
    await this.tickHalf("smart");
  }

  private async tickHalf(which: Half): Promise<void> {
    const connector = which === "standard" ? this.standardConnector : this.smartConnector;
    try {
      const result = await connector.ensureSecret();
      if (which === "standard") this.lastStandard = result;
      else this.lastSmart = result;
    } catch (error) {
      // Leave that half's cached status unchanged — the other half's tick
      // (already run, or about to run) is unaffected.
      try {
        this.onError(which, error);
      } catch (onErrorFailure) {
        // CONFIRMED HIGH in review: a caller-supplied `onError` (e.g. a
        // network-backed logging/APM sink) that itself throws must NEVER be
        // allowed to propagate out of here — doing so would break this
        // method's own per-half isolation guarantee (the standard half's
        // failure would prevent the smart half's tick from ever running that
        // cycle) and, reached via `start()`'s `void this.tick()` interval
        // callback, become an unhandled promise rejection that crashes the
        // whole process under Node's default rejection behavior. A second,
        // fixed `console.error` — never itself caller-overridable — is the
        // backstop of last resort.
        console.error(
          `dual-link-connector: the "${which}" half's onError callback itself threw —`,
          onErrorFailure,
        );
      }
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

  /**
   * Reads the cached per-half status WITHOUT triggering any new network/
   * signer call. Top-level `secret`/`expiresAt` prefer the standard half's
   * active values, falling back to the smart half's — the gate never cares
   * which half issued the secret.
   */
  status(): DualLinkStatus {
    const standard: DualLinkHalfStatus = this.lastStandard;
    const smart: DualLinkHalfStatus = this.lastSmart;
    const active = standard.status === "active" ? standard : smart.status === "active" ? smart : null;
    return {
      standard,
      smart,
      secret: active?.secret ?? null,
      expiresAt: active?.expiresAt ?? null,
    };
  }

  /**
   * Returns a closure suitable for `PythiaClientOptions.pythiaKey`: runs
   * `tick()` then resolves to `status().secret`, or `undefined` when neither
   * half is active. `tick()` itself never throws (per-half isolation above),
   * but this closure catches defensively anyway and resolves `undefined`
   * rather than rejecting — same contract as `PythiaConnector.keyProvider()`.
   */
  keyProvider(): () => Promise<string | undefined> {
    return async () => {
      try {
        await this.tick();
        return this.status().secret ?? undefined;
      } catch {
        return undefined;
      }
    };
  }
}
