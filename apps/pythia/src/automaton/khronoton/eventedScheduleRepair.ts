import { EVENTED_SERVER_RESOLVERS } from "./eventedResolvers.js";

/** The minimal better-sqlite3 surface this repair uses. */
export interface RepairDb {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

/**
 * Boot-time migration: force every EVENTED server-resolver cronoton scheduleless
 * (`external_fireable = 1`, `next_fire_at = NULL`).
 *
 * A cronoton created BEFORE the scheduleless enforcement (≤ v2.7.18) still carries a
 * real `next_fire_at` and shows a misleading "next fire in N hours" — and it can't be
 * fixed the normal ways: it's a server-resolver row, so it's DELETE-protected
 * ("system — pause, don't delete"), and khronoton-core's edit handler doesn't accept
 * `externalFireable`. Since Pythia owns the Khronoton DB and KNOWS these resolvers are
 * event-driven, it repairs its own system cronotons directly.
 *
 * Idempotent — the WHERE clause only touches rows that are still scheduled, so once
 * fixed it's a no-op. Guarded — a failure (e.g. a schema drift) is logged and never
 * blocks engine start. Returns the number of rows repaired.
 */
export function repairEventedScheduleless(
  db: RepairDb,
  resolverNames: Iterable<string> = EVENTED_SERVER_RESOLVERS,
): number {
  let fixed = 0;
  for (const name of resolverNames) {
    try {
      const res = db
        .prepare(
          `UPDATE codex_cronotons SET external_fireable = 1, next_fire_at = NULL
           WHERE server_resolver = ? AND (external_fireable != 1 OR next_fire_at IS NOT NULL)`,
        )
        .run(name);
      if (res.changes > 0) {
        fixed += res.changes;
        console.log(
          `[dual-link-activate] migrated evented cronoton "${name}" → scheduleless ` +
            `(${res.changes} row) — was showing a stale schedule`,
        );
      }
    } catch (err) {
      console.error(
        `[dual-link-activate] evented scheduleless repair failed for "${name}" (non-fatal):`,
        err,
      );
    }
  }
  return fixed;
}
