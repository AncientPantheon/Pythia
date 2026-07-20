import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  cancelExecuteBatch,
  commitCodexCronoton,
  deleteCodexCronoton,
  editCodexCronoton,
  executeNow,
  fetchFires,
  fetchSigners,
  getCodexCronoton,
  getExecuteBatch,
  listCodexCronotons,
  pauseCodexCronoton,
  recoverFire,
  resumeCodexCronoton,
  simulateCodexTx,
  startExecuteBatch,
  triggerCronoton,
} from "@ancientpantheon/khronoton-core/handlers";
import type {
  AuthSeam,
  Handler,
  HandlerContext,
  HandlerRequest,
} from "@ancientpantheon/khronoton-core/handlers";
import { createAdminGate } from "../../admin/routes.js";
import type { OidcConfig } from "../../admin/oidcConfig.js";
import type { CodexStore } from "../codexStore.js";
import { getKhronotonContext } from "./context.js";
import { createPythiaSignerSource } from "./keyResolver.js";

/**
 * The ancient-gated Khronoton admin surface — the server side of the scheduled-
 * signing UI. ONE catch-all under `/admin/khronoton` adapts Hono requests onto the
 * package's sixteen framework-agnostic handlers (`/handlers`), sharing the same
 * engine context (db + sealed-codex resolver + chain runtime) as the tick loop.
 *
 * Keyed: registered from the composition root (index.ts), lives under
 * `src/automaton/`, so the keyless client request path never reaches it.
 *
 * Auth: every route — read and mutate — sits behind the `ancient` session gate
 * (createAdminGate) enforced by Hono BEFORE dispatch. The package AuthSeam then
 * only arbitrates the mutation confirm bit: `requireConfirm` demands the
 * `x-khronoton-confirmed: 1` header the UI sends after its confirm gate resolves
 * (a missing confirm → 401 `admin_confirm_required`, which the client turns into
 * one re-prompt + retry). Read handlers ride the always-pass read gate.
 *
 * Route contract (segments under /admin/khronoton), mirroring the package:
 *   GET    /                          list          PATCH  /:id          edit
 *   POST   /                          commit        PATCH  /:id/pause    pause
 *   GET    /signers                   signers       PATCH  /:id/resume   resume
 *   POST   /simulate                  simulate      DELETE /:id          delete
 *   GET    /:id                       get           POST   /:id/execute  execute-now
 *   GET    /:id/fires                 fires         POST   /:id/trigger  trigger
 *   POST   /:id/fires/:fireId/recover recover
 *   POST   /:id/execute-batch  start  GET/DELETE /:id/execute-batch  poll/stop
 */

/** The confirm signal the UI's fetch adapter sends after its confirm gate resolves. */
const CONFIRMED_HEADER = "x-khronoton-confirmed";
const PREFIX = "/admin/khronoton";

type RouteMatch = { handler: Handler; params: Record<string, string> };

function match(method: string, seg: string[]): RouteMatch | null {
  if (seg.length === 0) {
    if (method === "GET") return { handler: listCodexCronotons, params: {} };
    if (method === "POST") return { handler: commitCodexCronoton, params: {} };
    return null;
  }
  if (seg.length === 1) {
    if (seg[0] === "signers" && method === "GET") return { handler: fetchSigners, params: {} };
    if (seg[0] === "simulate" && method === "POST") return { handler: simulateCodexTx, params: {} };
    const params = { id: seg[0] };
    if (method === "GET") return { handler: getCodexCronoton, params };
    if (method === "PATCH") return { handler: editCodexCronoton, params };
    if (method === "DELETE") return { handler: deleteCodexCronoton, params };
    return null;
  }
  if (seg.length === 2) {
    const params = { id: seg[0] };
    const tail = seg[1];
    if (tail === "fires" && method === "GET") return { handler: fetchFires, params };
    if (tail === "pause" && method === "PATCH") return { handler: pauseCodexCronoton, params };
    if (tail === "resume" && method === "PATCH") return { handler: resumeCodexCronoton, params };
    if (tail === "execute" && method === "POST") return { handler: executeNow, params };
    if (tail === "trigger" && method === "POST") return { handler: triggerCronoton, params };
    if (tail === "execute-batch") {
      if (method === "POST") return { handler: startExecuteBatch, params };
      if (method === "GET") return { handler: getExecuteBatch, params };
      if (method === "DELETE") return { handler: cancelExecuteBatch, params };
    }
    return null;
  }
  if (seg.length === 4 && seg[1] === "fires" && seg[3] === "recover" && method === "POST") {
    return { handler: recoverFire, params: { id: seg[0], fireId: seg[2] } };
  }
  return null;
}

/** Confirm-bit-only seam — the ancient session gate already ran in Hono middleware. */
function ancientAuthSeam(identity: { id?: string; email?: string }): AuthSeam {
  return {
    requireRead: () => ({ ok: true, identity }),
    requireConfirm: (req: HandlerRequest) =>
      req.confirmed === true
        ? { ok: true, identity }
        : { ok: false, response: { status: 401, body: { error: "admin_confirm_required" } } },
  };
}

export function registerKhronotonAdmin(app: Hono, cfg: OidcConfig, codex: CodexStore): void {
  const gate = createAdminGate(cfg);
  const signers = createPythiaSignerSource(codex);

  const dispatch = async (c: Context): Promise<Response> => {
    c.header("cache-control", "no-store");

    // Segments under the prefix (Hono gives the full matched path on c.req.path).
    const rest = c.req.path.slice(PREFIX.length).replace(/^\/+/, "");
    const seg = rest.length ? rest.split("/").filter(Boolean) : [];
    const method = c.req.method;
    const matched = match(method, seg);
    if (!matched) return c.json({ error: "not found" }, 404);

    let body: unknown;
    if (method !== "GET") body = await c.req.json().catch(() => undefined);

    const q: Record<string, string | string[]> = {};
    for (const [k, values] of Object.entries(c.req.queries())) {
      q[k] = values.length === 1 ? values[0] : values;
    }

    const session = c.get("adminSession") as { sub?: string; name?: string } | undefined;
    const handlerRequest: HandlerRequest = {
      params: matched.params,
      query: q,
      body,
      confirmed: c.req.header(CONFIRMED_HEADER) === "1",
    };

    let engine: Awaited<ReturnType<typeof getKhronotonContext>>;
    try {
      engine = await getKhronotonContext(codex);
    } catch {
      return c.json({ error: "khronoton engine unavailable — is PYTHIA_MASTER_KEY set?" }, 503);
    }

    const handlerContext: HandlerContext = {
      db: engine.db,
      runtime: engine.runtime,
      resolver: engine.resolver,
      resolveFireMode: engine.resolveFireMode,
      onAudit: engine.onAudit,
      config: engine.config,
      auth: ancientAuthSeam({ id: session?.sub, email: session?.name }),
      signers,
    };

    const res = await matched.handler(handlerContext, handlerRequest);
    // Hono's status arg is a union of literal codes; the handler's number is any HTTP status.
    return c.json(res.body, res.status as ContentfulStatusCode);
  };

  app.all(PREFIX, gate, dispatch);
  app.all(`${PREFIX}/*`, gate, dispatch);
}
