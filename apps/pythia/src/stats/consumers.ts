/**
 * Consumer attribution for usage analytics. A consumer is a named caller (an
 * ecosystem app, an oracle) identified by a secret API key it sends in the
 * `x-pythia-key` header. The key→name mapping comes from a DEPLOY-TIME secret
 * (`PYTHIA_API_KEYS`), NEVER from the public repo config — the keys are secrets.
 */

interface RawConsumerEntry {
  name?: unknown;
  key?: unknown;
}

/**
 * Parse the `PYTHIA_API_KEYS` secret (or a passed override) into a
 * `Map<key, name>`. The secret is a JSON `Array<{name,key}>`. A missing env
 * yields an empty map; invalid JSON logs a single warning and also yields an
 * empty map — analytics degrades to all-"direct" attribution rather than
 * crashing the boot. Entries missing a string name or key are skipped.
 */
export function loadConsumerMap(rawEnv?: string): Map<string, string> {
  const raw = rawEnv ?? process.env.PYTHIA_API_KEYS;
  const map = new Map<string, string>();
  if (raw === undefined || raw === "") return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      "PYTHIA_API_KEYS is not valid JSON — usage analytics will attribute all traffic to 'direct'",
    );
    return map;
  }

  if (!Array.isArray(parsed)) return map;
  for (const entry of parsed as RawConsumerEntry[]) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.name === "string" &&
      entry.name.length > 0 &&
      typeof entry.key === "string" &&
      entry.key.length > 0
    ) {
      map.set(entry.key, entry.name);
    }
  }
  return map;
}

/**
 * Resolve a request's `x-pythia-key` header to a consumer name. A registered
 * key returns its mapped name; an unknown or absent key returns "direct" (the
 * anonymous bucket).
 */
export function consumerFor(map: Map<string, string>, key?: string): string {
  if (key !== undefined) {
    const name = map.get(key);
    if (name !== undefined) return name;
  }
  return "direct";
}
