import { startKhronotonLoop } from "@ancientpantheon/khronoton-core/server";
import { getKhronotonContext } from "./context.js";
import { registerPythFlushResolver } from "./pythFlushResolver.js";
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
): Promise<void> {
  if (g.__pythiaKhronotonLoop) return;
  // Register the pyth-flush server resolver with the live ledger so a flush cronoton's
  // `entries` payload fills at fire time. Registered even if the loop is disabled, so a
  // manual fire / simulate still resolves. Idempotent.
  registerPythFlushResolver(ledger);
  if (process.env.KHRONOTON_DISABLED === "1") {
    console.log("[khronoton] disabled (KHRONOTON_DISABLED=1) — engine not started");
    return;
  }
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
