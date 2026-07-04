import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Broadcast/signing symbols the read-only service must never reference in its
 * own source. Phases 2-3 extend this list as new transport surfaces appear.
 */
export const BANNED_BROADCAST_SYMBOLS = [
  "submit",
  "listen",
  "pollOne",
  "createClient",
  "getFailoverClient",
] as const;

export type BannedSymbol = (typeof BANNED_BROADCAST_SYMBOLS)[number];

export interface Violation {
  file: string;
  symbol: BannedSymbol;
  line: number;
}

/**
 * Module specifiers the read-only service must never import. The sibling's
 * `network` module houses the write-capable failover client
 * (`getFailoverClient`), so importing it at all — even for a "read" — puts the
 * broadcast surface inside Pythia's import graph. Banning the import path is a
 * stronger boundary than banning only the symbol.
 */
export const BANNED_IMPORT_MODULES = [
  "@stoachain/stoa-core/network",
  // The reads barrel pulls createClient (from kadena-stoic-legacy) and the
  // network failover client (getFailoverClient / pollOne) transitively — the
  // banned wrapper path. Pythia builds /local, /poll and /cut over its own
  // dial() instead. The pure `@stoachain/stoa-core/pact` subpath is deliberately
  // NOT on this list: it re-exports zero-import format helpers (mayComeWithDeimal)
  // that the reads layer legitimately imports.
  "@stoachain/stoa-core/reads",
] as const;

export type BannedImportModule = (typeof BANNED_IMPORT_MODULES)[number];

export interface ImportViolation {
  file: string;
  importPath: BannedImportModule;
  line: number;
}

const bannedPattern = new RegExp(
  `\\b(${BANNED_BROADCAST_SYMBOLS.join("|")})\\b`,
  "g",
);

// Matches both `import ... from "<mod>"` (incl. bare `import "<mod>"`) and
// `require("<mod>")` so a CJS interop shim cannot smuggle the module in.
function bannedImportPatternFor(mod: string): RegExp {
  const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:from|import|require\\s*\\()\\s*["']${escaped}["']`,
  );
}

// The scanner's own definition file necessarily spells the banned symbols to
// enumerate them; it is the enforcement mechanism, not service transport code,
// so it is excluded from the scan to avoid flagging its own roster.
const SCANNER_FILENAME = "readOnlyScanner.ts";

function collectTsFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    if (entry === SCANNER_FILENAME) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
}

/**
 * Scan a directory tree of the service's own `.ts` source for any reference to
 * a banned broadcast/signing symbol. Word-boundary scoped so `resubmit` /
 * `submitButton` do not false-positive. Deliberately does NOT descend into
 * `node_modules` — a transitive dep may legitimately ship signing code; the
 * invariant is that Pythia's OWN source never reaches for these symbols.
 */
export function scanForBannedSymbols(srcDir: string): Violation[] {
  const files: string[] = [];
  collectTsFiles(srcDir, files);

  const violations: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      bannedPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = bannedPattern.exec(text)) !== null) {
        violations.push({
          file,
          symbol: match[1] as BannedSymbol,
          line: i + 1,
        });
      }
    });
  }
  return violations;
}

/**
 * Scan a directory tree of the service's own `.ts` source for any import of a
 * banned module (the write-capable network surface). Catches ESM `import`
 * (named, default, or bare side-effect) and CJS `require(...)`. Same
 * `node_modules`/self-exclusion walk as {@link scanForBannedSymbols}.
 */
export function scanForBannedImports(srcDir: string): ImportViolation[] {
  const files: string[] = [];
  collectTsFiles(srcDir, files);

  const violations: ImportViolation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const mod of BANNED_IMPORT_MODULES) {
        if (bannedImportPatternFor(mod).test(text)) {
          violations.push({ file, importPath: mod, line: i + 1 });
        }
      }
    });
  }
  return violations;
}
