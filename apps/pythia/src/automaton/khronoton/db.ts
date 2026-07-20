import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { installSchema } from "@ancientpantheon/khronoton-core/server";
import type { Database } from "@ancientpantheon/khronoton-core/server";
import type BetterSqlite3Ctor from "better-sqlite3";

/**
 * The Khronoton engine's SQLite home (ported from Mnemosyne). Set
 * `PYTHIA_KHRONOTON_DIR=/data/khronoton` in the Dockerfile so the cronoton store
 * survives blue-green redeploys on the mounted volume, like the sealed vault.
 */
export function khronotonDir(): string {
  return process.env.PYTHIA_KHRONOTON_DIR || join(process.cwd(), "pythia-khronoton");
}

const g = globalThis as unknown as { __pythiaKhronotonDb?: Database };

/** Open (once) the Khronoton DB with the engine schema installed (idempotent). */
export function getKhronotonDb(): Database {
  if (g.__pythiaKhronotonDb) return g.__pythiaKhronotonDb;
  const dir = khronotonDir();
  mkdirSync(dir, { recursive: true });
  // better-sqlite3 is a native CJS module — load it through a runtime require so no
  // bundler statically analyses it (harmless under plain Node/tsc, safest under any).
  const requireNative = createRequire(import.meta.url);
  const BetterSqlite3 = requireNative("better-sqlite3") as typeof BetterSqlite3Ctor;
  const db = new BetterSqlite3(join(dir, "khronoton.db"));
  db.pragma("journal_mode = WAL");
  const seam = db as unknown as Database; // structural exec/prepare seam.
  installSchema(seam);
  g.__pythiaKhronotonDb = seam;
  return seam;
}
