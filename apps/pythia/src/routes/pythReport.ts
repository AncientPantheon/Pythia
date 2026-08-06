import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { pondus, CLASS_BASE } from "../pyth/pondus.js";
import type { PythLedger } from "../pyth/ledger.js";
import { CONSUMER_HEADER, type ConsumerResolver } from "../stats/middleware.js";

/** Batch bounds — a report can never be unbounded work. */
const MAX_ENTRIES = 1000; // total transactions + reads per request
const MAX_COUNT = 1000; // per-entry repeat count
const MAX_BODY_BYTES = 256 * 1024;

export interface PythReportDeps {
  ledger: PythLedger;
  resolveConsumer: ConsumerResolver;
  /** Consumer names permitted to report (see pyth/reporters.ts). */
  reporters: Set<string>;
}

/** Finite, non-negative number → the value, else null. */
function nonNegNum(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
}
/** Integer in [1, MAX_COUNT]; absent → 1; anything else → null (reject). */
function boundedCount(x: unknown): number | null {
  if (x === undefined) return 1;
  return typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_COUNT ? x : null;
}

/**
 * Register `POST /pyth/report` — the metering-report ingress. An AUTHORIZED
 * reporter (an entity with its own direct node access, e.g. the AncientHub/Dalos)
 * submits a keyed, batched report of transactions AND reads it performed, so they
 * are counted in Pythia's Pyth ledger WITHOUT relaying the chain traffic through
 * her gateway (no round trip). Pythia RECOMPUTES read pondus from the raw
 * gas/bytes (a reporter can't inflate weight), and records into the FLEET ledger
 * ONLY — it never feeds the per-slot usage report (that would round-trip PythXP
 * back to the reporter, which it already attributes locally). Keyless: it records
 * counts, it never signs. `/pyth/report` is NOT a `/{chain}/{read|send|poll}`
 * path, so the gateway meter never sees it — no double-count.
 */
export function registerPythReport(app: Hono, deps: PythReportDeps): void {
  app.post(
    "/pyth/report",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c: Context) => c.json({ code: "pythia_validation", error: "report body too large" }, 413),
    }),
    async (c) => {
      // Reporter gate: resolve the consumer from the key; must be allow-listed.
      const consumer = deps.resolveConsumer(c.req.header(CONSUMER_HEADER));
      if (consumer === "direct" || !deps.reporters.has(consumer)) {
        return c.json({ code: "pythia_forbidden", error: "not an authorized reporter" }, 403);
      }

      const body = (await c.req.json().catch(() => null)) as
        | { transactions?: unknown; reads?: unknown }
        | null;
      if (body === null || typeof body !== "object") {
        return c.json({ code: "pythia_validation", error: "body must be a JSON object" }, 400);
      }
      const txs = Array.isArray(body.transactions) ? body.transactions : [];
      const reads = Array.isArray(body.reads) ? body.reads : [];
      if (txs.length + reads.length === 0) {
        return c.json({ code: "pythia_validation", error: "report has no entries" }, 400);
      }
      if (txs.length + reads.length > MAX_ENTRIES) {
        return c.json({ code: "pythia_validation", error: "report batch too large" }, 400);
      }

      // Validate the WHOLE batch first — a single bad entry rejects everything, so
      // a report is never partially recorded.
      const txPlan: Array<{ accepted: boolean; gasLimit: number; count: number }> = [];
      for (const t of txs) {
        const o = (t ?? {}) as { gasLimit?: unknown; accepted?: unknown; count?: unknown };
        const gasLimit = nonNegNum(o.gasLimit);
        const count = boundedCount(o.count);
        if (gasLimit === null || typeof o.accepted !== "boolean" || count === null) {
          return c.json({ code: "pythia_validation", error: "bad transaction entry" }, 400);
        }
        txPlan.push({ accepted: o.accepted, gasLimit, count });
      }
      const readPlan: Array<{ weight: number; count: number }> = [];
      for (const r of reads) {
        const o = (r ?? {}) as { gasUsed?: unknown; responseBytes?: unknown; count?: unknown };
        const gasUsed = nonNegNum(o.gasUsed);
        const responseBytes = nonNegNum(o.responseBytes);
        const count = boundedCount(o.count);
        if (gasUsed === null || responseBytes === null || count === null) {
          return c.json({ code: "pythia_validation", error: "bad read entry" }, 400);
        }
        // Pythia recomputes the weight — the reporter never supplies pondus.
        readPlan.push({ weight: pondus({ classBase: CLASS_BASE.read, gasUsed, responseBytes }), count });
      }

      // Record — fleet ledger ONLY, attributed to the reporter's consumer. Each
      // entry is ONE unit (tx/read) that occurred `count` times: `count` txs of
      // `gasLimit` each (so gas = gasLimit × count), and `count` petitions of the
      // recomputed weight each.
      for (const t of txPlan) deps.ledger.recordSend(t.accepted, t.gasLimit * t.count, t.count, consumer);
      for (const r of readPlan) {
        for (let i = 0; i < r.count; i++) deps.ledger.recordRead(r.weight, consumer);
      }

      return c.json({ ok: true, consumer, transactions: txPlan.length, reads: readPlan.length }, 200);
    },
  );
}
