import { registerServerResolver } from "@ancientpantheon/khronoton-core/server";
import type { SingleTxResolver } from "@ancientpantheon/khronoton-core/server";
import type { PythLedger, FlushToken, PythFlushEntry } from "../../pyth/ledger.js";

/**
 * Kadena command-value encodings. A RAW JS number is REJECTED inside a Pact command
 * (`@stoachain`/`@kadena` client: "Type `number` is not allowed in the command. Use
 * `{ decimal: … }` or `{ int: … }` instead") — and even in `env-data` a bare number is
 * ambiguous, so `read-msg` can't reliably reproduce the on-chain `object{…PythFlushEntry}`
 * schema's `integer`/`decimal` fields. Every numeric field must carry its Pact type
 * explicitly. See docs/HANDOFF-pythia-khronoton-flush.md.
 */
type PactInt = { int: string };
type PactDecimal = { decimal: string };

/** The wire shape of one flush entry — matches `PythiaLedgerV2.PYTHIA|S|PythFlushEntry`:
 *  `day:integer`, `iz-complete:bool`, `petitions:integer`, `pondus:DECIMAL`, and four more
 *  `integer` counters — with each number carrying its explicit Pact type. */
interface ChainFlushEntry {
  day: PactInt;
  "iz-complete": boolean;
  petitions: PactInt;
  pondus: PactDecimal;
  transactions: PactInt;
  "gas-reserved": PactInt;
  "failed-transactions": PactInt;
  "wasted-gas-reserved": PactInt;
}

const pactInt = (n: number): PactInt => ({ int: String(n) });
// `pondus` is already ≤3dp (rounded in `beginFlush`); `toString()` on that yields a clean
// decimal string, and the `{ decimal }` wrapper makes Pact read it as a `decimal` even when
// the value is whole (e.g. `{ decimal: "40" }` → Pact `40.0`, which a raw `40` would not).
const pactDecimal = (n: number): PactDecimal => ({ decimal: n.toString() });

/** Encode one ledger entry into the schema-typed, Pact-value-tagged shape `A_Flush`
 *  requires. `iz-complete` (a bool) needs no wrapper. */
export function toChainFlushEntry(e: PythFlushEntry): ChainFlushEntry {
  return {
    day: pactInt(e.day),
    "iz-complete": e["iz-complete"],
    petitions: pactInt(e.petitions),
    pondus: pactDecimal(e.pondus),
    transactions: pactInt(e.transactions),
    "gas-reserved": pactInt(e["gas-reserved"]),
    "failed-transactions": pactInt(e["failed-transactions"]),
    "wasted-gas-reserved": pactInt(e["wasted-gas-reserved"]),
  };
}

/**
 * The `pyth-flush` single-tx server resolver — the fire-time bridge between Pythia's
 * local Pyth ledger and the on-chain `PYTHIA|A_Flush(entries)` transaction (the drain
 * model; see docs/work/pyth-flush/design.md + docs/HANDOFF-pythia-khronoton-flush.md).
 *
 * A cronoton naming this resolver (`serverResolver: "pyth-flush"`) with pact code
 * `(…PYTHIA|A_Flush (read-msg "entries"))` gets its `entries` payload filled here at each
 * fire:
 *   - `resolve()` snapshots the current day-buckets into `entries[]` (WITHOUT mutating
 *     the ledger), ENCODES each entry's numbers into their explicit Pact types
 *     (`{ int }` / `{ decimal }` — see {@link toChainFlushEntry}) so `read-msg` reproduces
 *     the on-chain `object{…PythFlushEntry}` schema exactly, and carries the drain token as
 *     the settle plan.
 *   - `settle()` — invoked by the Khronoton ONLY on a confirmed on-chain success —
 *     drains exactly what was sent. A failed/unfired flush never settles, so the same
 *     data simply retries next tick.
 *
 * Keyed automaton core: registered from the engine start (composition root) with the
 * live ledger instance, never a static import of Pythia's read-side singleton.
 */

/** The canonical resolver name a flush cronoton must reference in `serverResolver`. */
export const PYTH_FLUSH_RESOLVER = "pyth-flush";

export function createPythFlushResolver(ledger: PythLedger): SingleTxResolver {
  return {
    kind: "single-tx",
    resolve() {
      const { entries, token } = ledger.beginFlush();
      return { plan: [token], payload: { entries: entries.map(toChainFlushEntry) } };
    },
    settle(plan) {
      const token = plan[0] as FlushToken | undefined;
      if (token) ledger.commitFlush(token);
    },
  };
}

/** Register the resolver in the package's global registry so the tick can consult it. */
export function registerPythFlushResolver(ledger: PythLedger): void {
  registerServerResolver(PYTH_FLUSH_RESOLVER, createPythFlushResolver(ledger));
}
