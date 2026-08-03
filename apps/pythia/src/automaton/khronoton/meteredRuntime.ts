import type {
  ChainRuntime,
  ChainClient,
  DirtyReadResult,
} from "@ancientpantheon/khronoton-core/server";
import type { PythLedger } from "../../pyth/ledger.js";
import { CLASS_BASE, pondus } from "../../pyth/pondus.js";

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
 * Wrap a `ChainRuntime` so EVERY on-chain action Pythia's automaton performs
 * through it is metered in her Pyth ledger — this is the whole point of Pythia as
 * the Pantheon's on-chain meter: her OWN automaton fires (Khronoton cronotons:
 * `A_Link`, `A_Flush`, …) submit straight to a node via this runtime and would
 * otherwise bypass the gateway meter, so nothing counted them.
 *
 *   - `submit`     → `recordSend` (a transaction; +gasReserved on accept, +failed
 *                    /+wastedGas on a rejected/thrown submit),
 *   - `dirtyRead`  → `recordRead` (a petition; class-weighted pondus).
 *
 * All metering is best-effort and NEVER alters the returned value or a thrown
 * error — a metering slip must not break a fire. Applied once at the shared
 * context (`getKhronotonContext`), so the tick loop, the event-driven fire, and
 * admin Execute Now/Simulate all meter through the same wrapper.
 */
export function meterChainRuntime(base: ChainRuntime, ledger: PythLedger): ChainRuntime {
  return {
    ...base,
    createClient(url: string): ChainClient {
      const client = base.createClient(url);
      return {
        listen: (desc) => client.listen(desc),
        async dirtyRead(tx: unknown): Promise<DirtyReadResult> {
          const res = await client.dirtyRead(tx);
          try {
            const bytes = Buffer.byteLength(JSON.stringify(res ?? {}), "utf8");
            ledger.recordRead(pondus({ classBase: CLASS_BASE.read, gasUsed: 0, responseBytes: bytes }));
          } catch {
            /* metering best-effort */
          }
          return res;
        },
        async submit(tx: unknown): Promise<{ requestKey: string }> {
          const gas = gasLimitOf(tx);
          try {
            const out = await client.submit(tx);
            try {
              ledger.recordSend(true, gas, 1);
            } catch {
              /* best-effort */
            }
            return out;
          } catch (err) {
            try {
              ledger.recordSend(false, gas, 1);
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
