/**
 * Resolve an `x-pythia-key` (or its absence) to a CONSUMER identity for usage
 * attribution. Returns BOTH the display `consumer` (what shows in `byConsumer` /
 * `/stats` / the pulse) AND whether the read is `keyed` (earns at the hub) — the
 * two are DIFFERENT and must not be conflated. Extracted from `index.ts` so the
 * precedence is unit-testable (it has regressed twice — v2.7.27, v2.7.32).
 *
 * Precedence:
 *   1. **No key → Pythia's OWN read.** A keyless read on Pythia's gateway is Pythia
 *      serving herself (her frontend reading chain data to display it, or anyone via
 *      her gateway without a consumer key). It ALWAYS attributes to `selfLabel`
 *      (`"pythia-self"`) — unifying her reads with her fires (which `meterChainRuntime`
 *      already labels `"pythia-self"`). It `keyed`-EARNS only when she has an active
 *      keyed self-connector (`selfSecret` present); otherwise it's her own read but
 *      counts as observation-only (not earning) — preserving the prior economics.
 *   2. A caller presenting Pythia's OWN self secret → `selfLabel`, keyed.
 *   3. An ephemeral bearer secret → its Apollo account (a real DualLinkConnector
 *      consumer: Mnemosyne, OuronetUI, …), keyed.
 *   4. A permanent admin-registered connector name, then the env key→name map — keyed.
 *   5. A key that resolves to NOTHING (unknown/expired) → `"direct"`, NOT keyed.
 */
export interface ResolvedConsumer {
  consumer: string;
  keyed: boolean;
}

export type ReadConsumerResolver = (key?: string) => ResolvedConsumer;

export interface ConsumerResolverDeps {
  /** Pythia's current self-connector secret (null/undefined when none is active). */
  selfSecret: () => string | null | undefined;
  /** Ephemeral-key store lookup → the minted key's Apollo account, or null. */
  resolveEphemeral: (secret: string) => { apolloAccount: string } | null;
  /** Permanent-connector store lookup → the connector's name, or null/undefined. */
  nameForKey: (key: string) => string | null | undefined;
  /** Env `PYTHIA_API_KEYS` map lookup → the configured name, or undefined. */
  envConsumer: (key: string) => string | undefined;
  /** The label for Pythia's own activity (`PYTHIA_SELF_CONSUMER` = "pythia-self"). */
  selfLabel: string;
}

export function makeResolveConsumer(deps: ConsumerResolverDeps): ReadConsumerResolver {
  return (key?: string): ResolvedConsumer => {
    const selfSecret = deps.selfSecret() || undefined;
    // Keyless → Pythia's own read. Always her identity; earns only with an active
    // keyed self-connector.
    if (!key) return { consumer: deps.selfLabel, keyed: selfSecret !== undefined };
    // A caller presenting Pythia's own self secret is Pythia herself, keyed.
    if (selfSecret !== undefined && key === selfSecret) return { consumer: deps.selfLabel, keyed: true };
    const eph = deps.resolveEphemeral(key);
    if (eph) return { consumer: eph.apolloAccount, keyed: true };
    const fromStore = deps.nameForKey(key);
    if (fromStore) return { consumer: fromStore, keyed: true };
    const fromEnv = deps.envConsumer(key);
    if (fromEnv) return { consumer: fromEnv, keyed: true };
    // A key was presented but matched nothing (unknown/expired) → anonymous, non-earning.
    return { consumer: "direct", keyed: false };
  };
}
