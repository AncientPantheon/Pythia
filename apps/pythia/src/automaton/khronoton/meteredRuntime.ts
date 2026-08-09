import type { ChainRuntime, ChainClient } from "@ancientpantheon/khronoton-core/server";
import type { PythLedger } from "../../pyth/ledger.js";

/** Fallback label for Pythia's OWN activity when her self dual-link isn't known yet
 * (boot, or before the operator pastes her dual-link-key). Once linked, her own
 * traffic — reads AND fires — attributes to her self dual-link Apollo account instead
 * (see {@link pythiaSelfConsumer}), so she is a first-class KEYED consumer of herself
 * (her 24h self-connector), not a separate `"pythia-self"` bucket. */
export const PYTHIA_SELF_CONSUMER = "pythia-self";

/** The composition root installs the real getter at boot (→ `selfApolloVault
 * .standardAccount()`), so Pythia's own reads + fires unify under her dual-link Apollo.
 * A settable module seam (rather than threading a getter through every
 * `getKhronotonContext` caller) that both the resolver and `meterChainRuntime` read. */
let selfConsumerGetter: () => string = () => PYTHIA_SELF_CONSUMER;
export function setPythiaSelfConsumer(fn: () => string): void {
  selfConsumerGetter = fn;
}
/** Pythia's own-activity consumer identity NOW — her self dual-link Apollo when linked,
 * else the `"pythia-self"` fallback. */
export function pythiaSelfConsumer(): string {
  return selfConsumerGetter() || PYTHIA_SELF_CONSUMER;
}

/**
 * Extract `meta.gasLimit` from a signed Kadena command (best-effort; 0 if absent
 * or unparseable). The executor hands `submit` a signed command whose `cmd` is the
 * canonical JSON string carrying `meta.gasLimit`.
 */
function gasLimitOf(tx: unknown): number {
  try {
    const cmd = (tx as { cmd?: unknown })?.cmd;
    if (typeof cmd === "string") {
      const meta = (JSON.parse(cmd) as { meta?: { gasLimit?: unknown } }).meta;
      const gl = meta?.gasLimit;
      return typeof gl === "number" && gl > 0 ? gl : 0;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

/**
 * Wrap a `ChainRuntime` so Pythia's automaton TRANSACTIONS are metered in her Pyth
 * ledger — her OWN fires (Khronoton cronotons: `A_Link`, `A_Flush`, …) submit
 * straight to a node via this runtime and would otherwise bypass the meter, so
 * nothing counted them (TRANSACTIONS stuck at 0 despite real fires).
 *
 *   - `submit` → `recordSend` (a transaction; +gasReserved on accept, +failed
 *     /+wastedGas on a rejected/thrown submit).
 *
 * ONLY the submit is metered. `dirtyRead` is DELIBERATELY passed through UNMETERED:
 * PETITIONS/PONDUS count only reads Pythia SERVES to a client (any client — her own
 * frontend displaying chain data, OuronetUI, Explorer, Mnemosyne — via the `/read`
 * gateway), NEVER Pythia's own internal dirty-read window (the automaton's
 * safety-simulates, gas calibration, etc.). Counting those would inflate petitions
 * with Pythia's own machinery. (An earlier build wrongly metered `dirtyRead` here —
 * corrected.)
 *
 * All metering is best-effort and NEVER alters the returned value or a thrown error —
 * a metering slip must not break a fire. Applied once at the shared context
 * (`getKhronotonContext`), so the tick loop, the event fire, and admin Execute Now
 * all meter through the same wrapper.
 */
export function meterChainRuntime(base: ChainRuntime, ledger: PythLedger): ChainRuntime {
  return {
    ...base,
    createClient(url: string): ChainClient {
      const client = base.createClient(url);
      return {
        // Pass-through, UNMETERED — Pythia's own dirty reads are not petitions.
        dirtyRead: (tx) => client.dirtyRead(tx),
        listen: (desc) => client.listen(desc),
        async submit(tx: unknown): Promise<{ requestKey: string }> {
          const gas = gasLimitOf(tx);
          try {
            const out = await client.submit(tx);
            try {
              ledger.recordSend(true, gas, 1, pythiaSelfConsumer());
            } catch {
              /* best-effort */
            }
            return out;
          } catch (err) {
            try {
              ledger.recordSend(false, gas, 1, pythiaSelfConsumer());
            } catch {
              /* best-effort */
            }
            throw err;
          }
        },
      };
    },
  };
}
