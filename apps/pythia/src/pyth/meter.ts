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

/**
 * Keyless Pyth-economy metering. After each operational request it records the
 * six ledger counters:
 *  - keyed **read/poll** (HTTP <400) → a Petition + its Pondus weight (read
 *    classBase 10 + node gas + response bytes; poll classBase 5, no gas).
 *    Anonymous reads are served but never earn, so they are not metered.
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
        if (status >= 400) return; // nothing served
        if (resolveConsumer(c.req.header(CONSUMER_HEADER)) === "direct") return; // anon never earns
        const bodyText = await c.res.clone().text();
        const responseBytes = Buffer.byteLength(bodyText, "utf8");
        const classBase = endpoint === "read" ? CLASS_BASE.read : CLASS_BASE.poll;
        const gasUsed = endpoint === "read" ? gasFromLocalResponse(bodyText) : 0;
        ledger.recordRead(pondus({ classBase, gasUsed, responseBytes }));
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
