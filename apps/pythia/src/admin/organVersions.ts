import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { HEALTH_TIMEOUT_MS } from "../health/resolver.js";
import type { FetchImpl } from "../dial/index.js";
import { isNewer } from "./versionInfo.js";

/**
 * The automaton organs Pythia carries as dependencies, surfaced in the Update &
 * Deploy panel's multi-version readout (Mnemosyne-style: entity + each organ). Their
 * INSTALLED version is read from node_modules; their AVAILABLE version is the npm
 * `dist-tags.latest` — best-effort, so the panel degrades to "installed only" offline.
 */
export interface OrganPackage {
  key: string;
  pkg: string;
  label: string;
}

export const ORGAN_PACKAGES: readonly OrganPackage[] = [
  { key: "codex", pkg: "@ancientpantheon/codex", label: "Codex" },
  { key: "khronoton", pkg: "@ancientpantheon/khronoton-core", label: "Khronoton" },
] as const;

export interface OrganVersion {
  key: string;
  label: string;
  pkg: string;
  installed: string;
  available: string | null;
  updateAvailable: boolean;
}

export interface OrganVersionOpts {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * The installed version of an organ package, read from its own package.json in
 * node_modules (the packages' `exports` maps don't expose `./package.json`, so a
 * direct path read is used). Walks up from cwd so it finds a HOISTED package in a
 * monorepo (organ packages live in the root node_modules, not apps/pythia's) as well
 * as a co-located one in the container (cwd=/app). `"unknown"` if unreadable.
 */
export function readInstalledOrganVersion(pkg: string): string {
  const segments = pkg.split("/");
  let dir = process.cwd();
  for (;;) {
    const pkgPath = join(dir, "node_modules", ...segments, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
      } catch {
        return "unknown";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return "unknown"; // reached filesystem root
    dir = parent;
  }
}

/**
 * The latest version PUBLISHED on npm (`dist-tags.latest`) for an organ package.
 * Returns `null` on any failure (offline, non-2xx, timeout, bad JSON). Uses the
 * abbreviated-packument accept header for a small response; not cached (a live check).
 */
export async function fetchLatestOrganVersion(
  pkg: string,
  opts: OrganVersionOpts = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = body["dist-tags"]?.latest;
    return typeof latest === "string" && latest ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Installed→available for every organ, with `updateAvailable` set only when the
 * registry is strictly newer. Runs the per-organ registry probes concurrently;
 * each degrades to `available: null` independently.
 */
export async function collectOrganVersions(opts: OrganVersionOpts = {}): Promise<OrganVersion[]> {
  return Promise.all(
    ORGAN_PACKAGES.map(async ({ key, pkg, label }) => {
      const installed = readInstalledOrganVersion(pkg);
      const available = await fetchLatestOrganVersion(pkg, opts);
      const updateAvailable =
        available !== null && installed !== "unknown" ? isNewer(available, installed) : false;
      return { key, label, pkg, installed, available, updateAvailable };
    }),
  );
}
