import { HEALTH_TIMEOUT_MS } from "../health/resolver.js";
import type { FetchImpl } from "../dial/index.js";

/**
 * The "available" version for the Update & Deploy panel: what a deploy would build,
 * i.e. the version on the repo's `main` (the deployer does `git pull` on main). The
 * repo is public, so Pythia reads it straight from raw GitHub. Best-effort — if it
 * can't be read, the panel shows the installed version and "available: unreachable".
 */
export const AVAILABLE_VERSION_URL =
  "https://raw.githubusercontent.com/AncientPantheon/Pythia/main/package.json";

export interface VersionInfoOpts {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  url?: string;
}

/** The version on `main`, or `null` on any failure (non-2xx, timeout, bad JSON). */
export async function fetchAvailableVersion(opts: VersionInfoOpts = {}): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const url = opts.url ?? AVAILABLE_VERSION_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a dotted numeric version into its parts; `null` when unparseable. */
function parts(v: string): number[] | null {
  const nums = v.split(".").map((p) => Number(p));
  if (nums.length < 1 || nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/** True only when `available` is a strictly higher semver than `installed`. Any
 * unparseable input → false (a bad value must not claim an update). */
export function isNewer(available: string, installed: string): boolean {
  const a = parts(available);
  const b = parts(installed);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}
