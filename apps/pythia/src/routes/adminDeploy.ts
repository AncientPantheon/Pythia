import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createAdminGate } from "../admin/routes.js";
import type { OidcConfig } from "../admin/oidcConfig.js";
import { PYTHIA_VERSION } from "../version.js";
import {
  deployMode,
  isTerminalStatus,
  isValidDeployId,
  latestDeploy,
  logPath,
  readStatus,
  seedDeployFiles,
} from "../deploy/spool.js";
import {
  devLogPath,
  readDevStatus,
  startDevConstructorUpdate,
} from "../deploy/devUpdate.js";

/**
 * Default hard cap on an SSE stream's lifetime: 20 minutes. A wedged deployer
 * that never writes a terminal status must not pin the connection open forever;
 * this is the fallback when {@link AdminDeployDeps.maxStreamMs} is unset.
 */
export const DEFAULT_MAX_STREAM_MS = 20 * 60 * 1000;

/** Knobs for the SSE tail loop — production defaults, shrunk by tests. */
export interface AdminDeployDeps {
  /** Poll interval for the log/status tail (ms). Default 500. */
  pollMs?: number;
  /** Hard cap on a stream's lifetime (ms). Default {@link DEFAULT_MAX_STREAM_MS}. */
  maxStreamMs?: number;
  /** The dev-mode constructor update. Injectable so tests never spawn a real npm. */
  startDevUpdate?: (id: string) => void;
}

/**
 * Register the `ancient`-gated on-box deploy API (the Update & Deploy panel's
 * backend). The container never touches git or the docker socket — POST only
 * seeds the spool files on the shared volume (see `../deploy/spool.ts`) and the
 * host's root path-unit runs the privileged blue-green deployer.
 *
 * - `GET  /api/admin/deploy/status`     — mode/color/port/version/container.
 * - `POST /api/admin/deploy`            — 409 in dev mode; else mint id + seed.
 * - `GET  /api/admin/deploy/stream/:id` — SSE tail of `<id>.log`: `data:` chunks
 *   from a byte offset every {@link AdminDeployDeps.pollMs}, `event: status` on
 *   change, `event: done` + close on terminal status, hard-capped at
 *   {@link AdminDeployDeps.maxStreamMs}.
 *
 * Gated with the SAME session guard as the rest of the admin surface
 * ({@link createAdminGate}): 401 unauthenticated, 403 without `ancient`.
 */
export function registerAdminDeploy(
  app: Hono,
  cfg: OidcConfig,
  deps: AdminDeployDeps = {},
): void {
  const gate = createAdminGate(cfg);
  const pollMs = deps.pollMs ?? 500;
  const maxStreamMs = deps.maxStreamMs ?? DEFAULT_MAX_STREAM_MS;

  app.get("/api/admin/deploy/status", gate, (c) => {
    // Never cache: the color/port flip on every deploy and mode drives the
    // enabled state of the Deploy button.
    c.header("Cache-Control", "no-store");
    const color = process.env.PYTHIA_COLOR || null;
    // Surface the most recent deploy so the panel can auto-attach its progress display
    // to one in flight (running) — even one this browser didn't trigger.
    const latest = latestDeploy();
    const active =
      latest && !isTerminalStatus(latest.status)
        ? { id: latest.id, status: latest.status, startedAt: latest.startedAt }
        : null;
    return c.json({
      mode: deployMode(),
      color,
      port: process.env.PORT || null,
      version: PYTHIA_VERSION,
      container: color ? `pythia-${color}` : null,
      active,
    });
  });

  app.post("/api/admin/deploy", gate, (c) => {
    // Gate on deployMode() BEFORE any spool path helper — they throw in dev
    // mode (no spool volume to seed into). On a dev box there is no blue-green
    // path, so Deploy instead pulls the automaton organs at @latest (Mnemosyne's
    // dev behaviour) and rebuilds the islands — same log/status contract, so the
    // SSE stream + progress display drive it unchanged.
    if (deployMode() === "dev") {
      const devId = randomUUID();
      (deps.startDevUpdate ?? startDevConstructorUpdate)(devId);
      return c.json({ id: devId, mode: "dev" });
    }
    const id = randomUUID();
    seedDeployFiles(id, { id, mode: "bundle", requestedAt: new Date().toISOString() });
    return c.json({ id, mode: "bundle" });
  });

  app.get("/api/admin/deploy/stream/:id", gate, (c) => {
    const id = c.req.param("id");
    // Path-traversal guard: the id is interpolated into spool file paths.
    if (!isValidDeployId(id)) {
      return c.json({ error: "invalid deploy id" }, 400);
    }
    const dev = deployMode() === "dev";
    return streamSSE(c, async (stream) => {
      // Dev box: tail the dev constructor-update log instead of the spool (which
      // does not exist here). Same tail loop, same terminal statuses.
      const file = dev ? devLogPath(id) : logPath(id);
      const statusOf = (): string | null => (dev ? readDevStatus(id) : readStatus(id));
      let offset = 0;
      let lastStatus: string | null = null;
      const deadline = Date.now() + maxStreamMs;
      while (!stream.aborted && Date.now() < deadline) {
        // Tail the log from the byte offset. A missing file is NOT an error —
        // the host deployer may not have started yet; keep polling.
        let size = 0;
        try {
          size = statSync(file).size;
        } catch {
          /* log not created yet */
        }
        if (size > offset) {
          const chunk = readFileSync(file).subarray(offset, size).toString("utf8");
          offset = size;
          await stream.writeSSE({ data: chunk });
        }
        const status = statusOf();
        if (status !== null && status !== lastStatus) {
          lastStatus = status;
          await stream.writeSSE({ event: "status", data: status });
        }
        if (isTerminalStatus(status)) {
          await stream.writeSSE({ event: "done", data: status as string });
          return;
        }
        await stream.sleep(pollMs);
      }
      // Deadline (or client abort): close without a done event — the deploy
      // itself may still be running; the client can reconnect.
    });
  });
}
