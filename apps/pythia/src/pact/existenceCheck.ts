import { dial, STOA_NETWORK } from "../dial/index.js";
import type { FetchImpl } from "../dial/index.js";
import { buildLocalCommand } from "../chainweb/localCommand.js";
import { resolveReadPair } from "../routes/relay.js";
import type { NodePool } from "../pool/nodePool.js";
import { PYTHIA_NAMES, PYTHIA_QUALIFIED, pythiaNameKeys } from "./names.js";
import type { PythiaNameKey } from "./names.js";

/**
 * Boot-time proof that every Pact name in the inventory exists on the DEPLOYED module.
 *
 * Pythia is fail-closed, so a dead read is indistinguishable from an empty world: the auth
 * cache stays empty, every consumer reads as inactive, and the fleet stops minting keys in
 * total silence. One check at startup — does every name I will call exist? — converts that
 * into a loud, named failure.
 *
 * ONE `describe-module` settles all of them: a Pact module hash changes on any redeploy, and
 * the returned `code` is the deployed source, so membership is a substring question rather
 * than N probe calls.
 */

/** Result of one boot check. */
export interface PactExistenceReport {
  /** True only when the module was read AND every inventory name is a member. */
  ok: boolean;
  /** Deployed module hash — changes on ANY redeploy. Surfaced in health. */
  moduleHash: string | null;
  /** Inventory names absent from the deployed module, with their call sites. */
  missing: { key: PythiaNameKey; fn: string; usedBy: string }[];
  /** Set when the module itself could not be read (offline, no node, malformed). */
  unreachable: string | null;
}

/** The chain the PYTHIA module lives on (env override, default 0). */
function pythiaChainId(): number {
  const raw = Number(process.env.PYTH_LEDGER_CHAIN);
  return Number.isInteger(raw) && raw >= 0 && raw <= 19 ? raw : 0;
}

/**
 * True when `code` declares `fn` as a callable member.
 *
 * Matches `(defun <fn>` / `(defcap <fn>` allowing the `:type` return annotation the house
 * style uses (`(defun URH_ListAllDualLinks:[object] ()`). Deliberately strict about the
 * opening paren + keyword so a mention in a docstring cannot vouch for a name that is gone —
 * prose mentions are exactly how the last two rounds looked plausible.
 */
export function declaresMember(code: string, fn: string): boolean {
  const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\((?:defun|defcap|defpact)\\s+${escaped}[\\s:(]`).test(code);
}

/** Read the deployed module's `code` + `hash` in one `/local`. */
async function describeModule(
  pool: NodePool,
  fetchImpl?: FetchImpl,
): Promise<{ code: string; hash: string } | { error: string }> {
  const pair = resolveReadPair({ pool });
  if (!pair) return { error: "no read node available" };
  const chainId = pythiaChainId();
  try {
    const res = await dial(
      {
        chainId,
        buildRequest: (host) => [
          `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: buildLocalCommand(
              `(let ((m (describe-module "${PYTHIA_QUALIFIED}"))) ` +
                `{"code": (at "code" m), "hash": (at "hash" m)})`,
              { chainId },
            ),
          },
        ],
      },
      { primary: pair.primary, fallback: pair.fallback, fetchImpl },
    );
    const body = (await res.json().catch(() => null)) as
      | { result?: { status?: string; data?: unknown; error?: { message?: string } } }
      | null;
    if (!body?.result) return { error: "malformed node response" };
    if (body.result.status !== "success") {
      return { error: body.result.error?.message ?? "describe-module failed" };
    }
    const data = body.result.data as { code?: unknown; hash?: unknown } | null;
    if (!data || typeof data.code !== "string" || typeof data.hash !== "string") {
      return { error: "describe-module returned an unexpected shape" };
    }
    return { code: data.code, hash: data.hash };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check every inventory name against the deployed module.
 *
 * Never throws — an unreachable chain is NOT a missing name, and must not take the service
 * down on a transient node failure. The caller decides how loud to be; see
 * {@link formatExistenceReport}.
 */
export async function checkPactNamesExist(
  pool: NodePool,
  fetchImpl?: FetchImpl,
): Promise<PactExistenceReport> {
  const described = await describeModule(pool, fetchImpl);
  if ("error" in described) {
    return { ok: false, moduleHash: null, missing: [], unreachable: described.error };
  }
  const missing = pythiaNameKeys()
    .filter((key) => !declaresMember(described.code, PYTHIA_NAMES[key].fn))
    .map((key) => ({ key, fn: PYTHIA_NAMES[key].fn, usedBy: PYTHIA_NAMES[key].usedBy }));
  return { ok: missing.length === 0, moduleHash: described.hash, missing, unreachable: null };
}

/**
 * The operator-facing line(s) for a report. Names the dead symbol AND its call site, because
 * "a read is broken" is actionable and "the fleet is quiet" is not.
 */
export function formatExistenceReport(report: PactExistenceReport): string {
  if (report.unreachable) {
    return `[pact-names] UNVERIFIED — could not read ${PYTHIA_QUALIFIED}: ${report.unreachable}`;
  }
  if (report.ok) {
    return `[pact-names] ok — ${pythiaNameKeys().length} names verified against ${PYTHIA_QUALIFIED} (module ${report.moduleHash})`;
  }
  const lines = report.missing.map((m) => `    ✗ ${m.fn}  <- ${m.usedBy}`);
  return (
    `[pact-names] DEAD PACT NAMES on ${PYTHIA_QUALIFIED} (module ${report.moduleHash}) — ` +
    `these calls resolve to nothing and FAIL SILENTLY:\n${lines.join("\n")}\n` +
    `    The module was redeployed and these were renamed or removed. Fix src/pact/names.ts.`
  );
}
