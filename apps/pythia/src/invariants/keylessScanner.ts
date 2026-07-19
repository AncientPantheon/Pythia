import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Broadcast/signing symbols the KEYLESS gateway must never reference in its own
 * source. Pythia never holds keys and never signs — it relays caller-supplied
 * payloads in either direction (a caller-signed /send broadcast is a plain fetch
 * to the node's /send, NOT any signing/submit client). These are the
 * signing/submit-client symbols that must stay out of Pythia's import graph.
 */
export const BANNED_BROADCAST_SYMBOLS = [
  "submit",
  "listen",
  "pollOne",
  "createClient",
  "getFailoverClient",
  // Key-GENERATION entry points on any dalos-crypto primitive. Pythia may call
  // `Apollo.verify` (pure public-data), but it must NEVER generate or hold a key —
  // banning these prevents an accidental keypair ever existing in Pythia's source,
  // which is what a `sign` call would require. Unambiguous names (no prose clash).
  "generateRandom",
  "generateFromSeedWords",
  "generateFromBitString",
  "generateFromInteger",
  "generateFromBitmap",
] as const;

export type BannedSymbol = (typeof BANNED_BROADCAST_SYMBOLS)[number];

export interface Violation {
  file: string;
  symbol: BannedSymbol;
  line: number;
}

/**
 * Module specifiers the KEYLESS gateway must never import. The sibling's
 * `network` module houses the write-capable failover client
 * (`getFailoverClient`), so importing it at all puts the signing/submit surface
 * inside Pythia's import graph. Pythia relays caller-signed txs with a plain
 * fetch to the node's /send instead. Banning the import path is a stronger
 * boundary than banning only the symbol.
 */
export const BANNED_IMPORT_MODULES = [
  "@stoachain/stoa-core/network",
  // The reads barrel pulls createClient (from kadena-stoic-legacy) and the
  // network failover client (getFailoverClient / pollOne) transitively — the
  // banned wrapper path. Pythia builds /local, /send, /poll and /cut over its own
  // dial() instead.
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

// Matches every way a module specifier can enter the graph: `... from "<mod>"`,
// bare `import "<mod>"`, `require("<mod>")`, AND dynamic `import("<mod>")`. The
// dynamic form is the one a CJS/lazy shim would otherwise smuggle a banned module
// in through (it evaded the earlier pattern).
function bannedImportPatternFor(mod: string): RegExp {
  const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*|import\\s+)["']${escaped}["']`,
  );
}

// The scanner's own definition file necessarily spells the banned symbols to
// enumerate them; it is the enforcement mechanism, not service transport code,
// so it is excluded from the scan to avoid flagging its own roster.
const SCANNER_FILENAME = "keylessScanner.ts";

/**
 * The KEYED automaton core — the sovereign half of Pythia (`automaton/02`): the
 * Codex (signing keys) + the Khronoton (scheduled autonomous signing). The keyless
 * invariant applies to the CONSTRUCTOR face (the client request path — "Pythiaeyes"),
 * NOT to this directory. It is signing code by design and is proven UNREACHABLE from
 * the constructor path by a separate isolation test, so the symbol/import scans skip
 * it. Any dir named `automaton` anywhere in the tree is the boundary.
 */
export const AUTOMATON_CORE_DIR = "automaton";

function collectTsFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    if (entry === AUTOMATON_CORE_DIR) continue; // keyed core — see above.
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
 * Collect the CONSTRUCTOR-face `.ts` files that must never import the keyed
 * automaton core — every `.ts` under `srcDir` except the `automaton/` boundary
 * itself. Used by the isolation check (the client path can't reach the keys).
 */
export function collectConstructorFiles(srcDir: string): string[] {
  const acc: string[] = [];
  collectTsFiles(srcDir, acc);
  return acc;
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
export interface IsolationViolation {
  file: string;
  specifier: string;
  line: number;
}

// Matches an import/require whose specifier reaches the automaton core: a relative
// `./automaton` / `../automaton[/...]` or any path segment `/automaton/`.
const AUTOMATON_IMPORT_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)["']((?:\.{1,2}\/)?(?:[^"']*\/)?automaton(?:\/[^"']*)?)["']/;

/**
 * Scan the CONSTRUCTOR-face files (everything except the `automaton/` boundary) for
 * any import that reaches into the keyed automaton core. Zero violations is the
 * isolation guarantee: the client request path cannot touch the Codex/signing.
 */
export function scanForAutomatonImports(srcDir: string): IsolationViolation[] {
  const files = collectConstructorFiles(srcDir);
  const violations: IsolationViolation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      const m = AUTOMATON_IMPORT_RE.exec(text);
      if (m) violations.push({ file, specifier: m[1], line: i + 1 });
    });
  }
  return violations;
}

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
