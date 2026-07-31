import type { Hono } from "hono";

/**
 * Pythia's in-process transport shortcut.
 *
 * This is her own composition root's way of wiring her own `PythiaConnector`/
 * `PythiaClient` instances (from `@ancientpantheon/pythia-client`) to reach HER OWN
 * route handlers directly, rather than hairpinning out over the public internet to
 * reach herself. See `docs/work/pythia-self-consumer/design.md` for the full
 * rationale: self-hairpinning over real HTTP would be strictly worse — extra
 * latency, an extra failure mode depending on her own public DNS/TLS reachability,
 * and a strange self-dependency.
 *
 * `Hono#request(input, requestInit)` is Hono's own documented in-process
 * testing/dispatch API: it dispatches directly through the app's real router with
 * NO real network hop (no DNS, no TLS, no socket), while still running the FULL
 * real route/middleware chain. This function wraps it so it matches `typeof
 * fetch`'s exact call signature, letting it be dropped directly into
 * `PythiaClientOptions.fetchImpl` / `PythiaConnectorOptions.fetchImpl`.
 */
export function createInProcessFetch(app: Hono): typeof fetch {
  return async (input, init) =>
    Promise.resolve(app.request(input as string | Request | URL, init));
}
