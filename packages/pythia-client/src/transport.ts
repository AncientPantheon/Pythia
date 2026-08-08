import type { PythiaClientOptions, RefreshablePythiaKey } from "./types.js";

/** The exact gateway body for a dead/orphaned gated key — the self-heal trigger.
 * Must stay byte-identical to `connectorGateMiddleware`'s 401 response. */
const INVALID_KEY_ERROR = "invalid or expired connector key";

function isRefreshableKey(k: PythiaClientOptions["pythiaKey"]): k is RefreshablePythiaKey {
  return typeof k === "object" && k !== null && typeof (k as RefreshablePythiaKey).invalidate === "function";
}

/** A parsed HTTP response: the numeric status plus the JSON-decoded body. */
export interface ParsedResponse {
  status: number;
  body: unknown;
}

/**
 * A thin typed transport over an injected `fetchImpl` (default global `fetch`).
 * Builds the request URL from `baseUrl` + path + query, issues the method, and
 * returns the parsed JSON body alongside the status so the caller can decide
 * how to map non-2xx responses. Owns no error-mapping policy itself.
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pythiaKey: PythiaClientOptions["pythiaKey"];

  constructor(options: PythiaClientOptions) {
    // Trim a trailing slash so `${baseUrl}${path}` never doubles the separator.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pythiaKey = options.pythiaKey;
  }

  /**
   * Resolve the `x-pythia-key` gated-access header value for THIS request. A
   * static string is used as-is; a supplier function is called (and awaited)
   * fresh every time, so a connector's rotating ephemeral secret is picked up
   * on each call rather than cached at construction. Returns `undefined` when
   * no `pythiaKey` option was given, or the supplier itself resolves to
   * `undefined` — either way, no header is sent.
   */
  private async resolvePythiaKey(): Promise<string | undefined> {
    if (this.pythiaKey === undefined) return undefined;
    if (typeof this.pythiaKey === "function") return this.pythiaKey();
    if (isRefreshableKey(this.pythiaKey)) return this.pythiaKey.get();
    return this.pythiaKey;
  }

  /** True when a parsed response is the gateway's "your gated key is dead" 401 AND
   * we hold a refreshable key that can re-mint — i.e. this request is self-healable. */
  private isSelfHealable401(res: ParsedResponse): boolean {
    return (
      res.status === 401 &&
      isRefreshableKey(this.pythiaKey) &&
      typeof res.body === "object" &&
      res.body !== null &&
      (res.body as { error?: unknown }).error === INVALID_KEY_ERROR
    );
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * Read the response body defensively. The gateway relays node responses
   * verbatim, so a node/gateway 5xx can arrive as HTML or an empty body. We read
   * `.text()` and JSON.parse inside a try/catch: on a parse failure we return the
   * raw text as the body so the caller maps by HTTP status rather than crashing
   * on an untyped SyntaxError. An empty body decodes to the empty string.
   */
  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === "") return "";
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** GET `path` with optional query params; returns status + parsed body. */
  async get(
    path: string,
    query?: Record<string, string>,
  ): Promise<ParsedResponse> {
    const pythiaKey = await this.resolvePythiaKey();
    const response = await this.fetchImpl(this.buildUrl(path, query), {
      headers: pythiaKey ? { "x-pythia-key": pythiaKey } : undefined,
    });
    return { status: response.status, body: await this.parseBody(response) };
  }

  /** POST `path` with a JSON body; returns status + parsed body. On a
   * self-healable gated `401` (dead ephemeral key + a refreshable key source),
   * invalidate → re-mint → retry EXACTLY ONCE with the fresh key. A second 401
   * surfaces (no loop). Concurrent 401s collapse to one re-mint because the
   * connector's `refresh()` is in-flight-deduped. */
  async postJson(path: string, body: unknown): Promise<ParsedResponse> {
    const first = await this.doPostJson(path, body);
    if (!this.isSelfHealable401(first)) return first;
    // pythiaKey is refreshable (guaranteed by isSelfHealable401).
    await (this.pythiaKey as RefreshablePythiaKey).invalidate();
    return this.doPostJson(path, body);
  }

  private async doPostJson(path: string, body: unknown): Promise<ParsedResponse> {
    const pythiaKey = await this.resolvePythiaKey();
    const response = await this.fetchImpl(this.buildUrl(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(pythiaKey ? { "x-pythia-key": pythiaKey } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await this.parseBody(response) };
  }
}
