import { Transport } from "./transport.js";
import {
  PythiaConnectorError,
  PythiaConnectorValidationError,
  PythiaConnectorSignatureError,
  PythiaConnectorNotLinkedError,
  PythiaConnectorUnavailableError,
} from "./connectorErrors.js";
import { InMemorySecretStorage, type SecretStorage } from "./secretStorage.js";

/** A cached secret within this margin of `expiresAt` is treated as needing
 * refresh, not just already-expired, so a consumer's in-flight request
 * doesn't race an about-to-expire secret. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The consumer's OWN signing injection point (e.g. a wrapper around Codex's
 * `autoSignApolloChallenge`, out of scope for this SDK). `PythiaConnector`
 * never holds key material and signs nothing itself — mirrors
 * `PythiaClient.send`'s existing "caller signs, we relay" philosophy.
 */
export interface ApolloSigner {
  sign(input: {
    apolloAccount: string;
    nonce: string;
    rp: string;
  }): Promise<{ signature: string }>;
}

/** The typed result of `ensureSecret()`/`refresh()`. A 202 "pending" verify
 * outcome is a legitimate steady state, not an error — see
 * `docs/work/pythia-client-connector-sdk/design.md` Decision 3. */
export type ConnectorSecretResult =
  | { status: "active"; secret: string; expiresAt: number }
  | { status: "pending" };

/** Constructor options for {@link PythiaConnector}. `storage` defaults to a
 * fresh `InMemorySecretStorage`; `refreshMarginMs` defaults to 5 minutes. */
export interface PythiaConnectorOptions {
  baseUrl: string;
  apolloAccount: string;
  signer: ApolloSigner;
  storage?: SecretStorage;
  fetchImpl?: typeof fetch;
  refreshMarginMs?: number;
  /** Called with any error `keyProvider()`'s closure swallows (a thrown
   * `PythiaConnectorError`, OR anything thrown by your OWN injected `signer`/
   * `storage` implementation — this catch is not scoped to this SDK's own
   * error types). Defaults to `console.error`. Set this if you need to
   * redact, filter, or route these errors through your own logging/APM
   * instead of an unconditional global `console.error` call — e.g. a buggy
   * signer that embeds sensitive material in a thrown `Error` message would
   * otherwise reach whatever's capturing `console.error` in production. */
  onKeyProviderError?: (error: unknown) => void;
}

/** Read the body's `error` string when present, else fall back to a default
 * message — the connector wire contract's error bodies are `{error: string}}`
 * but a defensive fallback keeps a malformed body from crashing the mapper. */
function bodyErrorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return fallback;
}

/**
 * Orchestrates Pythia's headless connector-auth protocol: challenge → sign →
 * verify → store. Exposes a single pull-based primitive, `ensureSecret()`,
 * that returns a cached still-valid secret or transparently refreshes — no
 * built-in timer/loop (see design Decision 1); a consumer drives refresh
 * cadence from whatever scheduling mechanism it already has.
 */
export class PythiaConnector {
  private readonly transport: Transport;
  private readonly apolloAccount: string;
  private readonly signer: ApolloSigner;
  private readonly storage: SecretStorage;
  private readonly refreshMarginMs: number;
  private readonly onKeyProviderError: (error: unknown) => void;
  /** The in-flight `refresh()` call, if any — memoized so concurrent
   * `ensureSecret()` callers (e.g. two simultaneous `PythiaClient` requests
   * both consulting `keyProvider()`) await the SAME round trip instead of
   * each independently firing its own challenge+verify (and its own signer
   * invocation, which may be expensive/rate-limited/user-facing). Cleared in
   * a `finally` regardless of outcome so a failed refresh doesn't wedge
   * every subsequent call behind a rejected promise forever. */
  private refreshing: Promise<ConnectorSecretResult> | null = null;

  constructor(options: PythiaConnectorOptions) {
    this.transport = new Transport({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    this.apolloAccount = options.apolloAccount;
    this.signer = options.signer;
    this.storage = options.storage ?? new InMemorySecretStorage();
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.onKeyProviderError = options.onKeyProviderError ?? ((error) => console.error(error));
  }

  /**
   * Returns a cached still-valid secret without any network call when one
   * exists and isn't within `refreshMarginMs` of expiring; otherwise
   * transparently performs a full `refresh()` (deduped against any already
   * in-flight `refresh()` — see `refreshing`).
   */
  async ensureSecret(): Promise<ConnectorSecretResult> {
    const cached = await this.storage.load();
    if (cached && cached.expiresAt - this.refreshMarginMs > Date.now()) {
      return {
        status: "active",
        secret: cached.secret,
        expiresAt: cached.expiresAt,
      };
    }
    return this.refresh();
  }

  /**
   * Unconditionally drives the full challenge → sign → verify round trip
   * against the injected `Transport`/`ApolloSigner`, mapping the verify
   * response to a typed result or a typed thrown error per the locked wire
   * contract. Concurrent calls share one in-flight round trip — see
   * `refreshing`.
   */
  async refresh(): Promise<ConnectorSecretResult> {
    if (this.refreshing) return this.refreshing;
    const run = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }

  private async doRefresh(): Promise<ConnectorSecretResult> {
    const challengeResponse = await this.transport.postJson(
      "/connectors/auth/challenge",
      { apolloAccount: this.apolloAccount },
    );
    if (challengeResponse.status === 400) {
      throw new PythiaConnectorValidationError(
        bodyErrorMessage(challengeResponse.body, "invalid apollo account"),
      );
    }
    if (challengeResponse.status !== 200) {
      // Anything other than the two documented outcomes (200/400) — e.g. a
      // transient gateway 502/503, or an HTML error page relayed verbatim
      // (see Transport.parseBody's own doc comment on why that's a real,
      // reachable shape) — is NOT the same failure class as a genuinely
      // invalid account; mislabeling it `PythiaConnectorValidationError`
      // would tell a consumer to stop retrying a transient failure.
      throw new PythiaConnectorError(
        `unexpected /connectors/auth/challenge status ${challengeResponse.status}: ${bodyErrorMessage(challengeResponse.body, "challenge failed")}`,
      );
    }
    const { nonce, rp } = challengeResponse.body as {
      nonce: string;
      rp: string;
      expiresAt: number;
    };

    const { signature } = await this.signer.sign({
      apolloAccount: this.apolloAccount,
      nonce,
      rp,
    });

    const verifyResponse = await this.transport.postJson(
      "/connectors/auth/verify",
      { apolloAccount: this.apolloAccount, nonce, signature },
    );

    switch (verifyResponse.status) {
      case 200: {
        const { secret, expiresAt } = verifyResponse.body as {
          secret: string;
          expiresAt: number;
        };
        await this.storage.save({ secret, expiresAt });
        return { status: "active", secret, expiresAt };
      }
      case 202:
        // Ownership proven, but not yet an active dual link — a legitimate
        // steady state, not an error. Any stale cached secret must not be
        // handed back by a later call once the account is known not-active.
        await this.storage.clear();
        return { status: "pending" };
      case 400:
        throw new PythiaConnectorValidationError(
          bodyErrorMessage(verifyResponse.body, "invalid or expired nonce"),
        );
      case 401:
        throw new PythiaConnectorSignatureError(
          bodyErrorMessage(
            verifyResponse.body,
            "signature verification failed",
          ),
        );
      case 403:
        throw new PythiaConnectorNotLinkedError(
          bodyErrorMessage(verifyResponse.body, "not an active dual link"),
        );
      case 502:
        throw new PythiaConnectorUnavailableError(
          bodyErrorMessage(
            verifyResponse.body,
            "verification temporarily unavailable",
          ),
        );
      default:
        throw new PythiaConnectorError(
          `unexpected /connectors/auth/verify status ${verifyResponse.status}`,
        );
    }
  }

  /**
   * Returns a closure suitable for `PythiaClientOptions.pythiaKey`: calls
   * `ensureSecret()` and resolves to the live secret when active, else
   * `undefined`. ANY error `ensureSecret()`/`refresh()` throws is caught here
   * — not just this SDK's own `PythiaConnectorError`s, but also whatever your
   * injected `signer`/`storage` implementations throw — and reported via
   * `onKeyProviderError` (defaults to `console.error`) rather than
   * propagated: this closure must never break an unrelated read/send/poll
   * call by rejecting. See `PythiaConnectorOptions.onKeyProviderError` if you
   * need to redact/filter/route these errors instead of the default.
   */
  keyProvider(): () => Promise<string | undefined> {
    return async () => {
      try {
        const result = await this.ensureSecret();
        return result.status === "active" ? result.secret : undefined;
      } catch (error) {
        this.onKeyProviderError(error);
        return undefined;
      }
    };
  }
}
