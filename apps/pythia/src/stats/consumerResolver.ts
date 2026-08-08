/**
 * Resolve an `x-pythia-key` (or its absence) to a CONSUMER identity for usage
 * attribution. Returns BOTH the display `consumer` (what shows in `byConsumer` /
 * `/stats` / the pulse) AND whether the read is `keyed` (earns at the hub) — the
 * two are DIFFERENT and must not be conflated. Extracted from `index.ts` so the
 * precedence is unit-testable (it has regressed twice — v2.7.27, v2.7.32).
 *
 * Precedence (see `docs/work/read-gate-self-key/design.md`):
 *   1. **No key → `"direct"`, NOT keyed.** After the read-gate hardening, a keyless
 *      request is NOT assumed to be Pythia — the old `no-key → pythia-self` shortcut is
 *      gone (it let any external keyless caller free-ride AND masquerade as Pythia).
 *      Pythia's OWN website reads now arrive with her self secret *injected server-side*
 *      for same-origin fetches (see `effectiveKey.ts`), so they resolve via #2, not here.
 *      A genuinely keyless request is rejected upstream by the gate before it is ever
 *      metered — so in practice this branch only guards a defensive/non-operational path.
 *   2. A caller presenting Pythia's OWN self secret → `selfLabel`, keyed.
 *   3. An ephemeral bearer secret → its Apollo account (a real DualLinkConnector
 *      consumer: Mnemosyne, OuronetUI, …), keyed.
 *   4. A permanent admin-registered connector name, then the env key→name map — keyed.
 *   5. A key that resolves to NOTHING (unknown/expired) → `"direct"`, NOT keyed.
 *
 * NOTE: `keyed === true` currently coincides exactly with "recognized" (a real
 * consumer, self, or env key) — the gate (`gateMiddleware.ts`) relies on this: it
 * rejects a request whose resolved `consumer === "direct"`.
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
  /** A RANDOM per-process marker injected (server-side only, never sent to clients) by
   *  `firstPartyKeyMiddleware` for same-origin keyless reads when Pythia has no active
   *  self secret — resolves to `selfLabel` UNKEYED, so her own site stays readable in the
   *  brief windows the self secret is absent. Optional (absent in unit tests that don't
   *  exercise the first-party path). */
  firstPartyMarker?: string;
}

export function makeResolveConsumer(deps: ConsumerResolverDeps): ReadConsumerResolver {
  return (key?: string): ResolvedConsumer => {
    const selfSecret = deps.selfSecret() || undefined;
    // Keyless → NOT Pythia by assumption (the old shortcut is gone). Anonymous,
    // non-earning; the gate rejects it before it is metered on operational paths.
    if (!key) return { consumer: "direct", keyed: false };
    // A caller presenting Pythia's own self secret is Pythia herself, keyed.
    if (selfSecret !== undefined && key === selfSecret) return { consumer: deps.selfLabel, keyed: true };
    // The server-injected first-party marker (same-origin read, no active self secret) →
    // Pythia herself, but NOT keyed (no active self-connector to earn). Never keyed, never
    // client-presentable (random per process).
    if (deps.firstPartyMarker && key === deps.firstPartyMarker) return { consumer: deps.selfLabel, keyed: false };
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
