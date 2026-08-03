import { executeNow } from "@ancientpantheon/khronoton-core/handlers";
import type {
  AuthSeam,
  HandlerContext,
  HandlerRequest,
} from "@ancientpantheon/khronoton-core/handlers";
import { findCodexCronotonIdByServerResolver } from "@ancientpantheon/khronoton-core/server";
import { getKhronotonContext } from "./context.js";
import { createPythiaSignerSource } from "./keyResolver.js";
import { DUAL_LINK_ACTIVATE_RESOLVER } from "./dualLinkActivateResolver.js";
import type { CodexStore } from "../codexStore.js";
import type { PendingActivationTracker } from "../../connectors/auth/pendingActivationTracker.js";

/**
 * TRUE event-driven activation. The `dual-link-activate` cronoton is SCHEDULELESS
 * (no `next_fire_at`, never auto-ticks) — it exists only as the on-chain template
 * (pact code + gas payer). The LINK EVENT — a pair becoming fully proven in the
 * `PendingActivationTracker` — fires it IMMEDIATELY, in-process, via the same
 * `executeNow` path the admin Fire button uses (resolve the ready pair →
 * safety-simulate → submit `A_LinkDualApiKey` → settle). No schedule, no polling.
 *
 * This is what makes activation genuinely event-driven end-to-end: the resolver
 * already resolves the payload on the event; this wires the FIRE TRIGGER to the
 * event too, instead of leaving it on Khronoton's schedule tick.
 */

/** Internal automaton fire (not a user request): the tracker is only ever fed by
 * VERIFIED ownership proofs, so the admin-confirm bit is auto-granted here. */
const internalAuthSeam: AuthSeam = {
  requireRead: () => ({ ok: true, identity: { id: "automaton" } }),
  requireConfirm: () => ({ ok: true, identity: { id: "automaton" } }),
};

/**
 * A single-flight, drain-to-empty activator. Returns a function to call on EVERY
 * link event; it:
 *  - drains every ready pair one-by-one (a fire commits+removes its pair, so the
 *    next iteration picks the next), gated on `hasReadyPair()` so an empty queue
 *    NEVER fires a blank `A_LinkDualApiKey`;
 *  - is single-flight: a call while a drain is in progress just flags a re-run, so
 *    concurrent pair-ready events can't double-fire the same row;
 *  - stops the drain on the first fire that doesn't succeed — the pair stays ready
 *    (never lost) and is retried on the next event, never a busy-loop on a bad tx.
 *
 * Injectable (`hasReadyPair`/`fireOnce`) so the drain/single-flight logic is unit
 * tested without a live engine.
 */
export function createEventDrivenActivator(deps: {
  hasReadyPair(): boolean;
  fireOnce(): Promise<boolean>;
}): () => Promise<void> {
  let draining = false;
  let rerun = false;
  return async function activate(): Promise<void> {
    if (draining) {
      rerun = true;
      return;
    }
    draining = true;
    try {
      do {
        rerun = false;
        while (deps.hasReadyPair()) {
          const ok = await deps.fireOnce();
          if (!ok) break; // leave the pair ready; a later event retries it
        }
      } while (rerun);
    } finally {
      draining = false;
    }
  };
}

/** Fire the scheduleless dual-link-activate cronoton once for the oldest ready
 * pair. Returns true iff `A_LinkDualApiKey` was submitted (so the drain loop
 * advances); false on any can't-fire condition (no engine, no cronoton, postpone,
 * error) — the pair stays ready. Never throws. */
async function fireOnce(codex: CodexStore): Promise<boolean> {
  let ctx: Awaited<ReturnType<typeof getKhronotonContext>>;
  try {
    ctx = await getKhronotonContext(codex);
  } catch (err) {
    console.error("[dual-link-activate] event fire: engine context unavailable:", err);
    return false;
  }
  const id = findCodexCronotonIdByServerResolver(DUAL_LINK_ACTIVATE_RESOLVER, { db: ctx.db });
  if (!id) {
    console.warn(
      `[dual-link-activate] event fire: no cronoton bound to "${DUAL_LINK_ACTIVATE_RESOLVER}" — ` +
        "create it (scheduleless) so the link event has a template to fire.",
    );
    return false;
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
    if (body.ok) {
      console.log(`[dual-link-activate] event fire: A_LinkDualApiKey submitted (cronoton ${id})`);
      return true;
    }
    console.error(
      "[dual-link-activate] event fire: not submitted:",
      body.error ?? `HTTP ${res?.status}`,
    );
    return false;
  } catch (err) {
    console.error("[dual-link-activate] event fire threw:", err);
    return false;
  }
}

/**
 * Wire the tracker's link event to the immediate in-process fire. Called once from
 * the engine start (composition root); after this, a pair becoming fully proven
 * fires `A_LinkDualApiKey` on the spot. Idempotent + single-flight.
 */
export function wireEventDrivenActivation(
  codex: CodexStore,
  tracker: PendingActivationTracker,
): void {
  const activate = createEventDrivenActivator({
    hasReadyPair: () => tracker.hasReadyPair(),
    fireOnce: () => fireOnce(codex),
  });
  tracker.setOnPairReady(() => {
    void activate();
  });
}
