import { dial, STOA_NETWORK, type DialNode, type FetchImpl } from "../../dial/index.js";
import { buildLocalCommand } from "../../chainweb/localCommand.js";

/** The namespace + module the PYTHIA consumer-key reads live in. */
const PYTHIA_NS = "ouronet-ns";

/** The length (chars) of one Apollo account half (standard OR smart) within a
 * composite `dual-link-key`. Exported so other Apollo-account-length checks
 * (e.g. connectorAuth.ts's headless validation) reuse this instead of
 * redefining the same fixed-format constant. */
export const APOLLO_ACCOUNT_LEN = 162;

/**
 * The separator the on-chain `UC_DualLinkKey`/`CT_Bar` composes a
 * `dual-link-key` with (`standard || CT_Bar || smart`). No existing exported
 * BAR/separator constant was found anywhere in this repo's TS code (checked
 * `canonicalMessage.ts` and grepped the whole tree for "BAR"/"CT_Bar" —
 * neither exists outside on-chain Pact source, which isn't checked out here).
 * This literal MUST stay byte-identical to the on-chain `CT_Bar` value.
 */
export const PYTHIA_DUAL_LINK_BAR = "|";

/** The {primary, fallback} nodes to read the active-dual-link set from. */
export interface DualLinkReadPair {
  primary: DialNode;
  fallback: DialNode;
}

function localReadPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`;
}

/**
 * Split one 325-char composite `dual-link-key` (`standard || BAR || smart`)
 * into its two 162-char Apollo-account halves.
 */
export function splitDualLinkKey(key: string): { standard: string; smart: string } {
  return {
    standard: key.slice(0, APOLLO_ACCOUNT_LEN),
    smart: key.slice(APOLLO_ACCOUNT_LEN + PYTHIA_DUAL_LINK_BAR.length),
  };
}

/**
 * Read the chain's active-`DualLink` set via a keyless Pact local read of
 * `(ouronet-ns.PYTHIA.URD_ListActiveDualLinks)`, and return a flat `Set` of
 * every standard AND smart Apollo account that is part of an active link.
 *
 * NOTE (v3.0.2): this previously called `UR_ActiveDualLinkSet`, which does NOT
 * exist on the deployed `ouronet-ns.PYTHIA` module — the read failed on every
 * poll, the fail-closed cache stayed empty, and so EVERY consumer's account
 * read as inactive (all `/verify` → `202 pending`, no `x-pythia-key` ever
 * minted, fleet-wide). Repointed to `URD_ListActiveDualLinks` — the live
 * function the landing page already uses — which returns active `DualLink` ROW
 * objects (`standard-apollo`, `smart-apollo`, `iz-active`, …); we take both
 * halves of each.
 *
 * Mirrors {@link readApolloPublicKey}'s request-building shape, but — unlike
 * that fail-closed-to-`null` read — REJECTS on any failure (bad response,
 * network error, malformed data) rather than resolving to an empty set. This
 * is deliberate: `DualLinkCache` is the fail-closed layer here (it starts
 * empty and only ever REPLACES its set on a successful poll), so this
 * function must let a failure surface as a rejection for the cache to keep
 * its last-good set instead of being handed a false "nothing is active".
 */
export async function readActiveDualLinkAccounts(
  pair: DualLinkReadPair,
  opts: { chainId?: number; fetchImpl?: FetchImpl } = {},
): Promise<Set<string>> {
  const chainId = opts.chainId ?? 0;
  const body = buildLocalCommand(`(${PYTHIA_NS}.PYTHIA.URD_ListActiveDualLinks)`, { chainId });

  const res = await dial(
    {
      chainId,
      buildRequest: (host) => [
        localReadPath(host, chainId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      ],
    },
    { primary: pair.primary, fallback: pair.fallback, fetchImpl: opts.fetchImpl },
  );
  const json = (await res.json()) as { result?: { status?: string; data?: unknown } };

  if (!json?.result || json.result.status !== "success") {
    throw new Error("dual-link active-set read failed");
  }

  const data = json.result.data;
  // A "success" status with a non-array `data` is a malformed/unexpected
  // response, not "zero active links" — this function's whole contract is to
  // REJECT on any failure (including a malformed success) so the cache never
  // mistakes "the read didn't make sense" for "nothing is active" and
  // silently replaces a populated set with an empty one.
  if (!Array.isArray(data)) {
    throw new Error("dual-link active-set read returned malformed data");
  }

  const accounts = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as {
      "standard-apollo"?: unknown;
      "smart-apollo"?: unknown;
      "iz-active"?: unknown;
    };
    // Defensive: URD_ListActiveDualLinks returns only actives, but never trust a
    // row explicitly flagged inactive.
    if (r["iz-active"] === false) continue;
    const std = r["standard-apollo"];
    const smart = r["smart-apollo"];
    if (typeof std === "string" && std.length > 0) accounts.add(std);
    if (typeof smart === "string" && smart.length > 0) accounts.add(smart);
  }
  return accounts;
}

/**
 * A cached, periodically-refreshed mirror of the on-chain active-`DualLink`
 * set, so challenge issuance/verification never needs a live chain read per
 * request. Fails closed: starts empty (nothing verifies as active until the
 * first successful poll), and — mirroring `NodePool.refreshNow`'s
 * keep-last-good-on-failure behavior — a failed poll NEVER clears the
 * previous successful set.
 *
 * The self-rescheduling `setTimeout` + `.unref()` loop mirrors `NodePool`'s
 * `start()`/`stop()` shape.
 */
export class DualLinkCache {
  private active: Set<string> = new Set();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly poll: () => Promise<Set<string>>;
  private readonly intervalMs: number;

  constructor(opts: {
    /** Injected so tests never touch the network — production wires this to
     * `() => readActiveDualLinkAccounts(pair)`. */
    poll: () => Promise<Set<string>>;
    /** Poll cadence. Default 60s. */
    intervalMs?: number;
  }) {
    this.poll = opts.poll;
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  /** Whether `apolloAccount` (standard or smart) is part of an active
   * on-chain `DualLink`, per the last successful poll. */
  isActiveAccount(apolloAccount: string): boolean {
    return this.active.has(apolloAccount);
  }

  /** One poll. On failure, keeps the last-good set and logs — never clears. */
  async refreshNow(): Promise<void> {
    try {
      this.active = await this.poll();
    } catch (err) {
      console.error(
        `pythia dual-link cache: poll failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Begin polling on `intervalMs`. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Self-rescheduling loop (mirrors NodePool.start): `running` guards
    // against rescheduling after stop() while a poll is in flight.
    const loop = async () => {
      await this.refreshNow();
      if (this.running) {
        this.timer = setTimeout(loop, this.intervalMs);
        this.timer.unref?.();
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
