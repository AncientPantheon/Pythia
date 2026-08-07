/**
 * Resolve an `x-pythia-key` (or its absence) to a CONSUMER identity for usage
 * attribution — the name/account that shows in `byConsumer`, `/stats`, and the
 * per-slot keyed/anon split. Extracted from `index.ts` so the precedence is unit-
 * testable (it has regressed before — see the v2.7.27 keyed-read miscount).
 *
 * Precedence:
 *   1. If the effective key IS Pythia's OWN self-connector secret → `selfLabel`
 *      (`"pythia-self"`). This UNIFIES all of Pythia's own activity under one
 *      identity: her keyless frontend reads AND her automaton fires (which
 *      `meterChainRuntime` already labels `"pythia-self"`). Without this, her reads
 *      resolve to her raw self-connector Apollo account and split away from her
 *      fires, so the "Pythia (self)" row shows 0 petitions even though she reads
 *      constantly.
 *   2. An ephemeral bearer secret → its Apollo account (a real DualLinkConnector
 *      consumer: Mnemosyne, OuronetUI, …).
 *   3. A permanent admin-registered connector name, then the env key→name map.
 *   4. Nothing → `"direct"` (anonymous). A keyless read with NO active self
 *      connector also lands here.
 *
 * `key` absent means "Pythia's own read": it defaults to her live self-connector
 * secret (step 1). A consumer's own key always overrides.
 */
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

export function makeResolveConsumer(deps: ConsumerResolverDeps): (key?: string) => string {
  return (key?: string): string => {
    const selfSecret = deps.selfSecret() || undefined;
    const effective = key || selfSecret;
    if (effective) {
      // Pythia's OWN key (keyless read, or a caller presenting her self secret) →
      // one unified identity, matching her fires.
      if (selfSecret !== undefined && effective === selfSecret) return deps.selfLabel;
      const eph = deps.resolveEphemeral(effective);
      if (eph) return eph.apolloAccount;
      const fromStore = deps.nameForKey(effective);
      if (fromStore) return fromStore;
      const fromEnv = deps.envConsumer(effective);
      if (fromEnv) return fromEnv;
    }
    return "direct";
  };
}
