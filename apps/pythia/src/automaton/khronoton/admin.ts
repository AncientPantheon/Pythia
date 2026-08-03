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
  listResolvers,
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
import {
  findCodexCronotonIdByServerResolver,
  getCodexCronoton as storeGetCronoton,
  deleteCodexCronoton as storeDeleteCronoton,
} from "@ancientpantheon/khronoton-core/server";
import { getKhronotonContext } from "./context.js";
import { createPythiaSignerSource } from "./keyResolver.js";
import { enforceEventedScheduleless, commitServerResolver } from "./eventedResolvers.js";

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
 *   GET    /resolvers                 resolver roster ({name,kind,evented}, 0.7.0+)
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
    // The server-authoritative resolver roster ({ name, kind, evented }) — the source
    // for showing which server resolvers exist and (cross-referenced with the cronoton
    // list) which are consumed. New in khronoton-core 0.7.0.
    if (seg[0] === "resolvers" && method === "GET") return { handler: listResolvers, params: {} };
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

    // EVENT-DRIVEN resolvers are scheduleless by construction: picking one (e.g.
    // `dual-link-activate`, fired by the link event) turns scheduling OFF. Enforce
    // it on COMMIT (POST /) — force externalFireable so the row is stored with
    // next_fire_at = NULL and the tick's due-query skips it. The system knowing the
    // resolver is evented is what disables the scheduler, exactly as intended.
    if (method === "POST" && seg.length === 0) body = enforceEventedScheduleless(body);

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

    // ONE resolver ↔ ONE cronoton. A server-resolver name may bind exactly one
    // cronoton: the fire lookup (findCodexCronotonIdByServerResolver) keys off the
    // name and returns the most-recent match, so a second cronoton on the same
    // resolver silently shadows the first (the wrong template fires). Reject a
    // COMMIT that reuses an already-bound resolver — delete the existing one first.
    if (method === "POST" && seg.length === 0) {
      const resolverName = commitServerResolver(body);
      if (resolverName && findCodexCronotonIdByServerResolver(resolverName, { db: engine.db })) {
        return c.json(
          {
            error:
              `a cronoton is already bound to server resolver "${resolverName}" — a server resolver ` +
              "may bind only one cronoton; delete the existing one before creating another",
          },
          409,
        );
      }
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

    // The execution routes (simulate / execute / trigger) follow khronoton-core's
    // own "HTTP 200 even on failure, the error rides in the body" convention
    // (REQ-H04); the UI's fetch adapter treats ANY non-2xx from them as an opaque
    // transport failure and renders a misleading "Simulation failed — network
    // error." with the real reason nowhere visible. So for these routes we make
    // sure the real error always reaches the UI in a 200 body — covering BOTH
    // failure shapes: a handler that THROWS (caught below), and — critically —
    // one that CATCHES its own throw and RETURNS a structured 5xx (khronoton-
    // core's `withConfirm` → `mapStoreError` does exactly this for a simulate's
    // internal chain/build/codex failure, so the throw never escapes the handler
    // and the catch below never sees it). Both are logged server-side too.
    const isExecutionRoute =
      method === "POST" &&
      (seg[0] === "simulate" ||
        (seg.length === 2 && (seg[1] === "execute" || seg[1] === "trigger")));

    let res: Awaited<ReturnType<Handler>>;
    try {
      res = await matched.handler(handlerContext, handlerRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[khronoton] handler ${method} /${seg.join("/")} threw:`, err);
      if (isExecutionRoute) return c.json({ ok: false, error: message }, 200);
      return c.json({ error: message }, 500);
    }

    if (isExecutionRoute && res.status >= 500) {
      const body = res.body as { error?: unknown } | undefined;
      const message = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
      console.error(`[khronoton] handler ${method} /${seg.join("/")} → ${res.status}: ${message}`);
      return c.json({ ok: false, error: message }, 200);
    }

    // Hono's status arg is a union of literal codes; the handler's number is any HTTP status.
    return c.json(res.body, res.status as ContentfulStatusCode);
  };

  // OVERRIDE DELETE — the escape hatch for a SYSTEM (server-resolver) cronoton, which
  // khronoton-core's normal delete refuses ("pause, don't delete"). Needed to clean up
  // a wrong/duplicate system cronoton (a server resolver binds only one — a leftover
  // can't otherwise be removed). Bypasses the protection by calling the STORE delete
  // directly. Ancient-gated + confirm-required + audited. Registered BEFORE the
  // catch-all so it wins the route match. Deleting the automaton's sole template
  // stops activation until it's recreated — deliberate, hence the confirm.
  app.post(`${PREFIX}/:id/force-delete`, gate, async (c: Context) => {
    c.header("cache-control", "no-store");
    const id = c.req.param("id");
    if (!id) return c.json({ error: "cronoton id is required" }, 400);
    if (c.req.header(CONFIRMED_HEADER) !== "1") {
      return c.json({ error: "admin_confirm_required" }, 401);
    }
    let engine: Awaited<ReturnType<typeof getKhronotonContext>>;
    try {
      engine = await getKhronotonContext(codex);
    } catch {
      return c.json({ error: "khronoton engine unavailable — is PYTHIA_MASTER_KEY set?" }, 503);
    }
    const row = storeGetCronoton(id, { db: engine.db });
    if (!row) return c.json({ error: "not found" }, 404);
    storeDeleteCronoton(id, { db: engine.db });
    const session = c.get("adminSession") as { sub?: string; name?: string } | undefined;
    await engine.onAudit?.({
      action: "codex_cronoton.force_delete",
      result: "ok",
      targetKind: "codex_cronoton",
      targetId: id,
      detail: {
        serverResolver: row.server_resolver ?? null,
        actor: session?.name ?? session?.sub ?? "ancient",
      },
    });
    return c.json({ ok: true, forced: true }, 200);
  });

  app.all(PREFIX, gate, dispatch);
  app.all(`${PREFIX}/*`, gate, dispatch);
}
