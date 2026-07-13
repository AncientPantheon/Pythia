import type { Hono } from "hono";
import type { VerifierStore } from "../verifiers/store.js";

export interface VerifiersDeps {
  store: VerifierStore;
}

/**
 * Register `GET /api/verifiers` — the PUBLIC list of enabled Apollo-ownership
 * verifiers the Connectors "Verify" popup offers. Admin-curated (empty until an
 * ancient admin adds one); exposes only `{ id, label, baseUrl }`, never any
 * admin-only field.
 */
export function registerVerifiers(app: Hono, deps: VerifiersDeps): void {
  app.get("/api/verifiers", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ verifiers: deps.store.enabled() });
  });
}
