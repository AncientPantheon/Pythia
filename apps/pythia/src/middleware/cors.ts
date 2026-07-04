import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

/**
 * CORS middleware for the read-only Pythia gateway.
 *
 * Browser apps (e.g. OuronetUI) read StoaChain data THROUGH Pythia cross-origin,
 * so the API responses must carry CORS headers or the browser blocks the fetch.
 * Because this is a public, read-only data gateway the default is permissive:
 * `origin: "*"`, methods GET/POST/OPTIONS, and the `content-type`/`accept`
 * request headers. When the operator pins an allowlist via `corsOrigins`, only
 * those origins are echoed back; an empty/absent list falls back to wildcard so
 * a mis-typed config never silently locks every browser out.
 */
export function corsMiddleware(corsOrigins?: string[]): MiddlewareHandler {
  const origin =
    corsOrigins !== undefined && corsOrigins.length > 0 ? corsOrigins : "*";

  return cors({
    origin,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept"],
  });
}
