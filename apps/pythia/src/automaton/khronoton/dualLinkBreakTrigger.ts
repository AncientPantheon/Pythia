import { executeNow } from "@ancientpantheon/khronoton-core/handlers";
import type { AuthSeam, HandlerContext, HandlerRequest } from "@ancientpantheon/khronoton-core/handlers";
import { findCodexCronotonIdByServerResolver } from "@ancientpantheon/khronoton-core/server";
import { getKhronotonContext } from "./context.js";
import { createPythiaSignerSource } from "./keyResolver.js";
import { DUAL_LINK_BREAK_RESOLVER } from "./dualLinkBreakResolver.js";
import type { CodexStore } from "../codexStore.js";

/** The internal auth seam — a break fired in-process by the ancient-gated route is
 * already authorized at the HTTP layer (createAdminGate), so the engine's own auth
 * is a pass-through. Mirrors dualLinkActivateTrigger's seam. */
const internalAuthSeam: AuthSeam = {
  requireRead: () => ({ ok: true, identity: { id: "automaton" } }),
  requireConfirm: () => ({ ok: true, identity: { id: "automaton" } }),
};

export interface BreakFireResult {
  ok: boolean;
  /** No cronoton is bound to `dual-link-break` yet (the operator hasn't created it). */
  cronotonMissing?: boolean;
  error?: string;
}

/**
 * Fire the `dual-link-break` cronoton ONCE, via the same `executeNow` path the admin
 * Fire button + the activation event use: find the cronoton bound to the resolver,
 * resolve its `dualAPI` payload from the `PendingBreakTracker`, safety-simulate, submit
 * `A_RevokeLink`, settle. Operator-initiated (called by `/admin/connectors/break`), so
 * there's no proof-event wiring. Returns a typed result; `cronotonMissing` when the
 * operator hasn't created the (scheduleless) `dual-link-break` cronoton yet.
 */
export async function fireDualLinkBreakOnce(codex: CodexStore): Promise<BreakFireResult> {
  let ctx: Awaited<ReturnType<typeof getKhronotonContext>>;
  try {
    ctx = await getKhronotonContext(codex);
  } catch (err) {
    return { ok: false, error: `engine context unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const id = findCodexCronotonIdByServerResolver(DUAL_LINK_BREAK_RESOLVER, { db: ctx.db });
  if (!id) {
    return { ok: false, cronotonMissing: true, error: `no cronoton bound to "${DUAL_LINK_BREAK_RESOLVER}"` };
  }
  const handlerCtx: HandlerContext = {
    db: ctx.db,
    runtime: ctx.runtime,
    resolver: ctx.resolver,
    resolveFireMode: ctx.resolveFireMode,
    onAudit: ctx.onAudit,
    config: ctx.config,
    auth: internalAuthSeam,
    signers: createPythiaSignerSource(codex),
  };
  const req: HandlerRequest = { params: { id }, query: {}, body: {}, confirmed: true };
  try {
    const res = await executeNow(handlerCtx, req);
    const body = (res?.body ?? {}) as { ok?: boolean; error?: string };
    if (body.ok) return { ok: true };
    return { ok: false, error: body.error ?? `HTTP ${res?.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
