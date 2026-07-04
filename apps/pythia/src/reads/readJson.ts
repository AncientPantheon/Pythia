import { PythiaUpstreamError } from "./errors.js";

/** Cap the upstream body snippet carried on the typed error so a large HTML
 * gateway page never bloats the error message. */
const SNIPPET_MAX = 300;

function snippet(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > SNIPPET_MAX
    ? `${trimmed.slice(0, SNIPPET_MAX)}…`
    : trimmed;
}

/**
 * Decode a node response body into JSON, guarding EVERY failure mode a live
 * chainweb node can present so a decode never becomes an unhandled `SyntaxError`
 * → raw 500. Used at every normalized-read parse site.
 *
 * - On a NON-OK response the body is read as TEXT (never `.json()` on it, which
 *   would throw on the node's plain-text error body) and a
 *   {@link PythiaUpstreamError} is thrown carrying the arrived HTTP status, a
 *   short body snippet, and the source URL.
 * - On an OK response the body is parsed inside a try/catch; a parse failure
 *   (a 200 that isn't JSON — e.g. a proxy page) throws
 *   {@link PythiaUpstreamError} with the arrived status so the route can map it
 *   to a 502.
 *
 * A both-hosts-down transport failure is NOT this path — it is thrown by
 * `dial()` as `PythiaPoolExhaustedError` before any response arrives.
 */
export async function readJson(
  response: Response,
  sourceUrl: string,
): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new PythiaUpstreamError({
      status: response.status,
      message: snippet(body) || `upstream returned HTTP ${response.status}`,
      source: sourceUrl,
    });
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new PythiaUpstreamError({
      status: response.status,
      message: `upstream returned a non-JSON body: ${snippet(text)}`,
      source: sourceUrl,
    });
  }
}
