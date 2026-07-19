import { rekeyCodex } from "@ancientpantheon/codex/ouronet";
import type { CodexSnapshot } from "@ancientpantheon/codex/ouronet";

/** The uploaded file is not a raw Codex snapshot (e.g. a wallet export envelope). */
export class NotASnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotASnapshotError";
  }
}

/** A raw Codex snapshot has `schemaVersion` + `kadenaSeeds`; a wallet export has
 * `kadenaWallets`/`ouronetWallets`. Guard the load flow against adopting the wrong file. */
function assertSnapshot(parsed: unknown): asserts parsed is CodexSnapshot {
  const o = parsed as Record<string, unknown> | null;
  if (!o || typeof o !== "object") {
    throw new NotASnapshotError("empty or non-object codex file");
  }
  if ("kadenaWallets" in o || "ouronetWallets" in o) {
    throw new NotASnapshotError("this is a wallet export, not a raw Codex snapshot");
  }
  if (typeof o.schemaVersion !== "number" || !Array.isArray(o.kadenaSeeds)) {
    throw new NotASnapshotError("not a Codex snapshot (expected schemaVersion + kadenaSeeds)");
  }
}

/**
 * Re-key a Codex backup blob from `oldPassword` to `newPassword` via the codex
 * package's pure `rekeyCodex` (Handoff 07). Powers both operator flows:
 *  - **download** re-encrypts the machine password → the operator's chosen password;
 *  - **load/adopt** re-encrypts the file's password → the machine password.
 * `rekeyCodex` throws `WrongPasswordError` on a bad `oldPassword` BEFORE mutating
 * anything (it works on a clone), so a failed re-key never damages the source.
 */
export async function rekeyBackupBlob(
  blobJson: string,
  oldPassword: string,
  newPassword: string,
): Promise<{ blob: string; skipped: unknown[] }> {
  const parsed = JSON.parse(blobJson) as unknown;
  assertSnapshot(parsed);
  const result = await rekeyCodex(parsed, oldPassword, newPassword);
  return { blob: JSON.stringify(result.snapshot), skipped: result.skipped ?? [] };
}
