import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_GAS_CEILING,
  LISTEN_TIMEOUT_MS,
  MANUAL_BATCH_INTERVAL_SECONDS,
  MANUAL_BATCH_MAX,
  MANUAL_BATCH_MIN,
  SINGLE_TX_GAS_GUARD,
  TICK_BATCH_LIMIT,
  TICK_INTERVAL_MS,
} from "@ancientpantheon/khronoton-core/server";
import type { AuditEvent, Config, OnAudit, ResolveFireMode, TickCtx } from "@ancientpantheon/khronoton-core/server";
import { getKhronotonDb, khronotonDir } from "./db.js";
import { createPythiaKeyResolver } from "./keyResolver.js";
import { getChainRuntime } from "./runtime.js";
import type { CodexStore } from "../codexStore.js";

/**
 * Assembly of the six Khronoton injection seams (handoff 05): db (SQLite on the data
 * volume), resolver (Pythia's sealed operator codex), runtime (the StoaChain adapter),
 * onAudit (JSONL trail beside the db), resolveFireMode ('live' — real transactions), and
 * the full Config. ONE shared ctx serves the tick loop AND the admin handlers.
 */
function auditLog(event: AuditEvent): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  try {
    const dir = khronotonDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "audit.jsonl"), `${line}\n`);
  } catch {
    /* the audit trail must never break a fire */
  }
  if (event.result === "failure" || event.result === "error") {
    console.warn(`[khronoton audit] ${line}`);
  }
}

export function buildKhronotonConfig(): Config {
  const tickOverride = Number(process.env.KHRONOTON_TICK_MS);
  return {
    tickIntervalMs: Number.isFinite(tickOverride) && tickOverride > 0 ? tickOverride : TICK_INTERVAL_MS,
    listenTimeoutMs: LISTEN_TIMEOUT_MS,
    autoGasCeiling: AUTO_GAS_CEILING,
    singleTxGasGuard: SINGLE_TX_GAS_GUARD,
    tickBatchLimit: TICK_BATCH_LIMIT,
    manualBatch: { min: MANUAL_BATCH_MIN, max: MANUAL_BATCH_MAX, intervalSeconds: MANUAL_BATCH_INTERVAL_SECONDS },
  };
}

const onAudit: OnAudit = auditLog;
const resolveFireMode: ResolveFireMode = () => "live";

const g = globalThis as unknown as { __pythiaKhronotonCtx?: Promise<TickCtx> };

/** The shared engine context — built once per process, reused by loop + handlers. */
export function getKhronotonContext(codex: CodexStore): Promise<TickCtx> {
  if (g.__pythiaKhronotonCtx) return g.__pythiaKhronotonCtx;
  g.__pythiaKhronotonCtx = (async (): Promise<TickCtx> => ({
    db: getKhronotonDb(),
    resolver: createPythiaKeyResolver(codex),
    runtime: await getChainRuntime(),
    onAudit,
    resolveFireMode,
    config: buildKhronotonConfig(),
  }))();
  return g.__pythiaKhronotonCtx;
}
