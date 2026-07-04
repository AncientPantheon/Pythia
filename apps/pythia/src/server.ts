import { serve } from "@hono/node-server";
import { app } from "./index.js";
import { resolvePort } from "./port.js";

const port = resolvePort();

// Boot the wired read gateway over @hono/node-server. This is the entry the
// Dockerfile `CMD` runs (node dist/server.js) and the `start` script mirrors.
serve({ fetch: app.fetch, port }, (info) => {
  // Structured boot line so the container logs show the live bind address.
  console.log(`pythia listening on http://0.0.0.0:${info.port}`);
});
