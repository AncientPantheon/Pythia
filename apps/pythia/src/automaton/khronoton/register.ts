import { startKhronotonLoop, getServerResolver } from "@ancientpantheon/khronoton-core/server";
import { getKhronotonContext } from "./context.js";
import { registerPythFlushResolver, PYTH_FLUSH_RESOLVER } from "./pythFlushResolver.js";
import {
  registerDualLinkActivateResolver,
  DUAL_LINK_ACTIVATE_RESOLVER,
} from "./dualLinkActivateResolver.js";
import { wireEventDrivenActivation } from "./dualLinkActivateTrigger.js";
import type { PendingActivationTracker } from "../../connectors/auth/pendingActivationTracker.js";
import type { CodexStore } from "../codexStore.js";
import type { PythLedger } from "../../pyth/ledger.js";

/**
 * Boot the Khronoton tick loop (ported from Mnemosyne). Dormant-safe: a failed start is
 * caught and never takes the app down (the rest of Pythia keeps serving), and with no
 * cronotons scheduled the loop ticks with nothing to fire. `KHRONOTON_DISABLED=1` is a
 * kill switch. Called from the composition root (server.ts) after libsodium is ready.
 */
const g = globalThis as unknown as { __pythiaKhronotonLoop?: { stop(): void } };

export async function startPythiaKhronotonEngine(
  codex: CodexStore,
  ledger: PythLedger,
  pendingActivation: PendingActivationTracker,
): Promise<void> {
  if (g.__pythiaKhronotonLoop) return;
  // Register the pyth-flush server resolver with the live ledger so a flush cronoton's
  // `entries` payload fills at fire time. Registered even if the loop is disabled, so a
  // manual fire / simulate still resolves. Idempotent.
  registerPythFlushResolver(ledger);
  // Register the dual-link-activate server resolver with the live pairing tracker,
  // THREADED IN as a parameter (never a static import of the composition root's
  // singleton — see dualLinkActivateResolver.ts's own doc comment on why) so a
  // `dual-link-activate` cronoton's `standardApollo`/`smartApollo` payload fills at
  // fire time. Same idempotent, disabled-loop-safe registration as the flush resolver.
  registerDualLinkActivateResolver(pendingActivation);
  // TRUE event-driven activation: a pair becoming fully proven fires the
  // scheduleless `dual-link-activate` cronoton IMMEDIATELY (no schedule tick). Wired
  // to the SAME tracker the resolver drains, so the event both resolves the payload
  // AND triggers the fire. Skipped when the engine is disabled (kill switch below).
  if (process.env.KHRONOTON_DISABLED === "1") {
    console.log("[khronoton] disabled (KHRONOTON_DISABLED=1) — engine not started");
    return;
  }
  wireEventDrivenActivation(codex, pendingActivation);
  try {
    const ctx = await getKhronotonContext(codex);
    g.__pythiaKhronotonLoop = startKhronotonLoop(ctx);
    console.log(`[khronoton] tick loop started (interval ${ctx.config.tickIntervalMs}ms)`);
  } catch (err) {
    // A failed engine start must never take the whole app down — Pythia still serves.
    console.error("[khronoton] tick loop FAILED to start:", err);
  }
}

export function stopPythiaKhronotonEngine(): void {
  g.__pythiaKhronotonLoop?.stop();
  g.__pythiaKhronotonLoop = undefined;
}

/**
 * Whether the Khronoton tick loop is currently running — the single truthful
 * signal (the loop handle is only set at a successful `startKhronotonLoop`, and
 * cleared by `stopPythiaKhronotonEngine`). Used by the automaton liveness
 * ("green check") surface. When `KHRONOTON_DISABLED=1`, or the engine failed to
 * start, or it was stopped, the global stays/returns `undefined` → false.
 */
export function isPythiaKhronotonLoopRunning(): boolean {
  return g.__pythiaKhronotonLoop !== undefined;
}

/**
 * Whether BOTH of Pythia's autonomous server resolvers are registered — the
 * activation pipeline (`dual-link-activate`, fires `A_LinkDualApiKey`) and the
 * pyth-flush pipeline. These register even when the loop is disabled (before the
 * `KHRONOTON_DISABLED` check), so this reflects "the automaton's pipelines are
 * wired" independently of whether the tick loop happens to be running.
 */
export function areAutomatonResolversRegistered(): boolean {
  return (
    getServerResolver(DUAL_LINK_ACTIVATE_RESOLVER) !== undefined &&
    getServerResolver(PYTH_FLUSH_RESOLVER) !== undefined
  );
}
