import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { surfaceHash } from "@ouronet/talos-registry";
import type { PactExistenceReport } from "./existenceCheck.js";

/**
 * The contract-surface identity this build is composing, for `/healthz`.
 *
 * Two daimons on different surfaces are composing different contracts, and until now
 * nothing in the fleet would say so. Three values, each answering a different question:
 *
 *   talosVersion / talosSurfaceHash — which snapshot of the CALLABLE (transaction) surface
 *     this build was compiled against. Comparable across consumers.
 *   pythiaModuleHash — the hash of the DEPLOYED `ouronet-ns.PYTHIA` module, read at boot.
 *     This is the one that matters for Pythia's own reads: a Pact module hash changes on ANY
 *     redeploy, so a changed value here is the signal that reader names may have moved. It
 *     changed silently in 2026-09 (URD_ -> URH_) and took the Connectors panel out.
 */
export interface PactSurfaceInfo {
  talosVersion: string | null;
  talosSurfaceHash: string;
  pythiaModuleHash: string | null;
  /** "ok" — every inventory name verified · "dead-names" · "unverified" · "pending". */
  namesStatus: "ok" | "dead-names" | "unverified" | "pending";
  /** Dead symbols, when there are any — named, because "the fleet is quiet" is not actionable. */
  deadNames?: string[];
}

/**
 * Installed `@ouronet/talos-registry` version, read from its package.json ON DISK so it
 * cannot lie about what is actually installed (the brief's rule, and OuronetUI's).
 *
 * Walks up for `node_modules/@ouronet/talos-registry/package.json` rather than resolving the
 * specifier: the package's `exports` map declares only an `import` condition and does not
 * expose `./package.json`, so BOTH `require.resolve(...)` and
 * `import ... from "@ouronet/talos-registry/package.json"` fail (ERR_PACKAGE_PATH_NOT_EXPORTED).
 * Same walk-up shape as `admin/organVersions.ts`.
 */
function readTalosVersion(): string | null {
  const segments = ["@ouronet", "talos-registry", "package.json"];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", ...segments);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" && parsed.version ? parsed.version : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const TALOS_VERSION = readTalosVersion();

let lastReport: PactExistenceReport | null = null;

/** Record the boot check's outcome for `/healthz`. Called once by the composition root. */
export function recordPactExistence(report: PactExistenceReport): void {
  lastReport = report;
}

/** The surface block `/healthz` reports. */
export function pactSurface(): PactSurfaceInfo {
  const base = {
    talosVersion: TALOS_VERSION,
    talosSurfaceHash: surfaceHash,
    pythiaModuleHash: lastReport?.moduleHash ?? null,
  };
  if (!lastReport) return { ...base, namesStatus: "pending" };
  if (lastReport.unreachable) return { ...base, namesStatus: "unverified" };
  if (!lastReport.ok) {
    return { ...base, namesStatus: "dead-names", deadNames: lastReport.missing.map((m) => m.fn) };
  }
  return { ...base, namesStatus: "ok" };
}
