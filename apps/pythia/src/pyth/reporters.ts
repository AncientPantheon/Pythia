/**
 * The metering-report allow-list. Only consumers named here may POST
 * `/pyth/report` to record traffic they performed against their OWN direct node
 * access (the AncientHub / Dalos) — see `routes/pythReport.ts`. The ingress can
 * inflate the ledger, so it is NEVER open: an unauthorized (or anonymous) key is
 * rejected. Sourced from the deploy-time `PYTHIA_REPORTERS` env — a
 * comma-separated list of consumer identifiers (the name/account `resolveConsumer`
 * returns for the reporter's `x-pythia-key`). Mirrors `stats/consumers.ts`.
 */
export function loadReporters(rawEnv?: string): Set<string> {
  const raw = rawEnv ?? process.env.PYTHIA_REPORTERS;
  const set = new Set<string>();
  if (raw === undefined || raw === "") return set;
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name.length > 0) set.add(name);
  }
  return set;
}
