import type { Context, Next } from "hono";
import { CLASS_BASE, pondus } from "./pondus.js";
import type { PythLedger } from "./ledger.js";
import type { ConsumerResolver } from "../stats/middleware.js";

/** Only the three operational verbs are metered — `/{chain}/{read|send|poll}`. */
const OPERATIONAL = /^\/([^/]+)\/(read|send|poll)$/;
const CONSUMER_HEADER = "x-pythia-key";

/** Extract the chainweb `/local` `gas` from a read response body (0 if absent or
 * not a Pact-local shape). Keyless — reads only the node's reported number. */
export function gasFromLocalResponse(bodyText: string): number {
  try {
    const g = (JSON.parse(bodyText) as { gas?: unknown }).gas;
    return typeof g === "number" && Number.isFinite(g) && g > 0 ? g : 0;
  } catch {
    return 0;
  }
}

/** The reserved gasLimit of each caller-SIGNED cmd, one entry per cmd (0 for a
 * malformed cmd). Keyless — it only READS `meta.gasLimit` from the caller's own
 * command. Parallel to the cmds array, so it pairs positionally with the send
 * response's requestKeys. */
export function gasLimitsForCmds(cmds: unknown): number[] {
  if (!Array.isArray(cmds)) return [];
  return cmds.map((c) => {
    try {
      const cmdStr = (c as { cmd?: unknown }).cmd;
      if (typeof cmdStr !== "string") return 0;
      const gl = (JSON.parse(cmdStr) as { meta?: { gasLimit?: unknown } }).meta?.gasLimit;
      return typeof gl === "number" && Number.isFinite(gl) && gl > 0 ? gl : 0;
    } catch {
      return 0;
    }
  });
}

/** Count + total reserved gas across a send's cmds (derived from {@link gasLimitsForCmds}). */
export function reservedGasForCmds(cmds: unknown): { txCount: number; gasLimit: number } {
  const arr = gasLimitsForCmds(cmds);
  return { txCount: arr.length, gasLimit: arr.reduce((a, b) => a + b, 0) };
}

/** The requestKeys chainweb returned for an accepted send batch (order matches cmds). */
export function requestKeysFromSendResponse(bodyText: string): string[] {
  try {
    const rk = (JSON.parse(bodyText) as { requestKeys?: unknown }).requestKeys;
    return Array.isArray(rk) ? rk.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** The tracker the meter hands accepted-send requestKeys to (see pyth/txTracker.ts). */
export interface TxTrackerLike {
  track(entries: Array<{ requestKey: string; gasLimit: number }>): void;
}

/** The per-slot windowed meter + the slot→operator lookup (see stats/slotUsage.ts,
 * pool/nodePool.ts). `operatorForSlot` returns the operator, `null` (unearning
 * hub slot), or `undefined` (not a hub slot — an Upload-Pool/seed node, skipped). */
export interface SlotMeter {
  usage: { record(slotId: string, operator: string | null, keyed: boolean, ok: boolean, pondus: number): void };
  operatorForSlot(id: string): string | null | undefined;
}

/**
 * Keyless Pyth-economy metering. After each operational request it records the
 * six ledger counters:
 *  - **read/poll** (HTTP <400) → a Petition + its Pondus weight (read classBase 10 +
 *    node gas + response bytes; poll classBase 5, no gas) in Pythia's OWN fleet
 *    ledger — for EVERY served read, anonymous included (observation). Only KEYED
 *    reads' pondus flows onward to the per-slot hub report (the minting path); an
 *    anonymous read counts for Pythia but earns no operator any PythXP.
 *  - **send** → a relay of N txs: HTTP 2xx = accepted (transactions + reserved
 *    gas); HTTP 502 = relay-rejected (failed-transactions + wasted gas). A
 *    400/413/503 is not a relay attempt and is skipped.
 * It reads only response gas/bytes and the caller's own `gasLimit` — it never
 * signs, holds keys, or broadcasts. Metering is best-effort: any failure inside
 * is swallowed so it can never affect the response.
 */
export function pythMeterMiddleware(
  ledger: PythLedger,
  resolveConsumer: ConsumerResolver,
  tracker?: TxTrackerLike,
  slot?: SlotMeter,
) {
  return async (c: Context, next: Next): Promise<void> => {
    const match = OPERATIONAL.exec(c.req.path);
    if (match === null) {
      await next();
      return;
    }
    const endpoint = match[2];

    await next();

    try {
      const status = c.res.status;

      if (endpoint === "read" || endpoint === "poll") {
        if (status >= 400) return; // not served
        const keyed = resolveConsumer(c.req.header(CONSUMER_HEADER)) !== "direct";

        // Compute pondus for EVERY served read/poll and record it in Pythia's OWN
        // fleet ledger — anonymous (non-Pythia-keyed) reads count toward her
        // Petitions/Pondus too, for observation. They just never earn: only KEYED
        // pondus flows to the per-slot hub report (the minting path) below.
        const bodyText = await c.res.clone().text();
        const responseBytes = Buffer.byteLength(bodyText, "utf8");
        const classBase = endpoint === "read" ? CLASS_BASE.read : CLASS_BASE.poll;
        const gasUsed = endpoint === "read" ? gasFromLocalResponse(bodyText) : 0;
        const pondusVal = pondus({ classBase, gasUsed, responseBytes });
        ledger.recordRead(pondusVal); // fleet ledger — ALL served reads/polls

        // Per-slot usage (the money path): hub-slot READS only (§4.3 excludes
        // polls), keyed AND anon recorded, but only KEYED pondus earns.
        // operatorForSlot is undefined for a non-hub id (Upload-Pool/seed) — those
        // never earn and are not reported.
        if (slot && endpoint === "read") {
          const slotId = c.get("servedSlotId");
          if (slotId) {
            const operator = slot.operatorForSlot(slotId);
            if (operator !== undefined) {
              slot.usage.record(slotId, operator, keyed, true, keyed ? pondusVal : 0);
            }
          }
        }
        return;
      }

      // send — only 2xx (accepted) or 502 (relay-rejected) is a real relay attempt.
      if (status < 200 || (status >= 300 && status !== 502)) return;
      const parsed = (await c.req.json().catch(() => null)) as { cmds?: unknown } | null;
      const gasLimits = gasLimitsForCmds(parsed?.cmds);
      if (gasLimits.length === 0) return;
      const sum = gasLimits.reduce((a, b) => a + b, 0);

      if (status >= 200 && status < 300) {
        // ACCEPTED. With a tracker wired, hand each requestKey to it for the
        // execution-level outcome (counted once it mines) instead of counting
        // here — no double count. Without a tracker (or with no requestKeys in
        // the response), fall back to the relay-level optimistic count.
        if (tracker) {
          const rks = requestKeysFromSendResponse(await c.res.clone().text());
          const entries = rks.map((requestKey, i) => ({ requestKey, gasLimit: gasLimits[i] ?? 0 }));
          if (entries.length > 0) {
            tracker.track(entries);
            return;
          }
        }
        ledger.recordSend(true, sum, gasLimits.length);
        return;
      }
      // 502 — relay-rejected (never entered the mempool): failed + wasted at relay.
      ledger.recordSend(false, sum, gasLimits.length);
    } catch {
      /* metering is best-effort — never let it touch the response */
    }
  };
}
