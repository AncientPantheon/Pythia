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

/** Count the txs and sum the reserved gasLimit across a send's caller-SIGNED
 * cmds. Keyless — it only READS `meta.gasLimit` from the caller's own command;
 * a malformed cmd is still counted (a tx) but contributes no gas. */
export function reservedGasForCmds(cmds: unknown): {
  txCount: number;
  gasLimit: number;
} {
  if (!Array.isArray(cmds)) return { txCount: 0, gasLimit: 0 };
  let gasLimit = 0;
  for (const c of cmds) {
    try {
      const cmdStr = (c as { cmd?: unknown }).cmd;
      if (typeof cmdStr !== "string") continue;
      const meta = (JSON.parse(cmdStr) as { meta?: { gasLimit?: unknown } }).meta;
      const gl = meta?.gasLimit;
      if (typeof gl === "number" && Number.isFinite(gl) && gl > 0) gasLimit += gl;
    } catch {
      /* skip a malformed cmd */
    }
  }
  return { txCount: cmds.length, gasLimit };
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
      const { txCount, gasLimit } = reservedGasForCmds(parsed?.cmds);
      if (txCount === 0) return;
      ledger.recordSend(status >= 200 && status < 300, gasLimit, txCount);
    } catch {
      /* metering is best-effort — never let it touch the response */
    }
  };
}
