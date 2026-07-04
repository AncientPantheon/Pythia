import type { PythiaClientOptions } from "./types.js";

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

  constructor(options: PythiaClientOptions) {
    // Trim a trailing slash so `${baseUrl}${path}` never doubles the separator.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    const response = await this.fetchImpl(this.buildUrl(path, query));
    return { status: response.status, body: await this.parseBody(response) };
  }

  /** POST `path` with a JSON body; returns status + parsed body. */
  async postJson(path: string, body: unknown): Promise<ParsedResponse> {
    const response = await this.fetchImpl(this.buildUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await this.parseBody(response) };
  }
}
