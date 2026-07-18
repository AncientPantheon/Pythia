import type { Hono } from "hono";
import type { PythLedger } from "../pyth/ledger.js";

/**
 * Register `GET /pyth` — Pythia's public Pyth-economy ledger view: the fleet-wide
 * running TOTAL of the six counters (petitions, pondus, transactions, gasReserved,
 * failedTransactions, wastedGasReserved) plus the per-UTC-day series. No auth — a
 * read-only, aggregate-only odometer. Keyless: it reports, it never signs.
 */
export function registerPyth(app: Hono, ledger: PythLedger): void {
  app.get("/pyth", (c) =>
    c.json(
      {
        total: ledger.total(),
        daily: ledger.daily(),
        generatedAt: new Date().toISOString(),
      },
      200,
    ),
  );
}
