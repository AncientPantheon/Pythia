import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { registerHealthz } from "./routes/healthz.js";
import { registerRpc } from "./routes/rpc.js";
import { registerGetBalance } from "./routes/getBalance.js";
import { registerGetConfirmations } from "./routes/getConfirmations.js";
import { registerConnectors } from "./routes/connectors.js";
import { corsMiddleware } from "./middleware/cors.js";
import { loadConfigFromDisk } from "./config/index.js";

/**
 * The Pythia gateway application.
 *
 * A bootable Hono instance wired with the Phase-2 transport routes —
 * `GET /healthz` (service liveness + per-source reachability + active routing)
 * and `POST /stoachain/rpc` (verbatim read relay over Pythia's own two-host
 * failover dial) — plus the Phase-3 normalized reads:
 * `GET /api/v1/getBalance` (composite IGNIS / OURO-dispo / virtual-OURO picture
 * + optional DPTF token supply) and `GET /api/v1/getConfirmations` (decoded
 * pending-vs-final status/depth). All reads run over the same failover dial and
 * reach no broadcast/signing surface.
 *
 * It also serves the static landing page at `/` (source-health list + connector
 * links) plus `GET /api/v1/connectors` (the config-driven connector list). The
 * landing surface is read-only — it polls `/healthz` and reads connectors; it
 * signs nothing.
 */
export const app = new Hono();

// The hand-written static landing assets, resolved relative to this module so
// serving is independent of the process CWD (container runs from /app, local
// `npm start` runs from apps/pythia). dist layout mirrors src, so from
// dist/index.js the assets sit at ../public.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Browser apps read StoaChain data THROUGH Pythia cross-origin, so CORS is
// applied to every route before the handlers. The allowlist is operator-tunable
// via config `corsOrigins`; absent/empty falls back to a permissive wildcard
// for this public read-only gateway. Same-origin static assets are unaffected.
app.use("*", corsMiddleware(loadConfigFromDisk().corsOrigins));

// API + health routes are registered BEFORE the `/` static catch-all so the
// static handler never shadows `/healthz`, `/stoachain/rpc`, or `/api/v1/*`.
registerHealthz(app);
registerRpc(app);
registerGetBalance(app);
registerGetConfirmations(app);
registerConnectors(app);

// Serve the landing page + its assets at `/`. `root` is absolute so it resolves
// the same regardless of where the process was started from.
app.use("/*", serveStatic({ root: PUBLIC_DIR, index: "index.html" }));

export default app;
