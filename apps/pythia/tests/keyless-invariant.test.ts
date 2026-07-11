import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, basename } from "node:path";
import {
  BANNED_BROADCAST_SYMBOLS,
  BANNED_IMPORT_MODULES,
  scanForBannedSymbols,
  scanForBannedImports,
} from "../src/invariants/keylessScanner.js";

const SERVICE_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

describe("keyless invariant scanner", () => {
  it("exposes the exact banned broadcast/signing symbol list", () => {
    // The signing/submit-client surface + the dalos-crypto key-GENERATION entry
    // points. Pythia never signs and never generates a key; it relays caller-signed
    // payloads and only ever calls the pure-public-data `Apollo.verify`.
    expect([...BANNED_BROADCAST_SYMBOLS].sort()).toEqual(
      [
        "createClient",
        "generateFromBitString",
        "generateFromBitmap",
        "generateFromInteger",
        "generateFromSeedWords",
        "generateRandom",
        "getFailoverClient",
        "listen",
        "pollOne",
        "submit",
      ].sort(),
    );
  });

  describe("against a seeded fixture", () => {
    let fixtureDir: string;

    beforeAll(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), "pythia-scan-"));
      const nested = join(fixtureDir, "nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(nested, "offender.ts"),
        `import { getFailoverClient } from "@stoachain/stoa-core/network";\nconst c = getFailoverClient();\nc.submit();\n`,
      );
      writeFileSync(
        join(fixtureDir, "clean.ts"),
        `export const answer = 42;\n`,
      );
    });

    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("flags a source file that references a banned symbol", () => {
      // The scanner must catch getFailoverClient + submit as word-boundary refs.
      const violations = scanForBannedSymbols(fixtureDir);

      const symbols = new Set(violations.map((v) => v.symbol));
      expect(symbols.has("getFailoverClient")).toBe(true);
      expect(symbols.has("submit")).toBe(true);
      expect(violations.some((v) => v.file.endsWith("offender.ts"))).toBe(true);
    });

    it("flags a source file that IMPORTS the write-capable network module", () => {
      // The offender fixture imports @stoachain/stoa-core/network — the module
      // housing getFailoverClient. The boundary bans not just the symbol but any
      // import of that signing-capable transport module at all.
      const importViolations = scanForBannedImports(fixtureDir);
      expect(
        importViolations.some((v) => v.file.endsWith("offender.ts")),
      ).toBe(true);
      expect(
        importViolations.some((v) =>
          v.importPath.includes("@stoachain/stoa-core/network"),
        ),
      ).toBe(true);
    });

    it("does NOT flag a clean file that imports no banned module", () => {
      // The clean fixture imports nothing banned, so the import scan is empty for it.
      const importViolations = scanForBannedImports(fixtureDir);
      expect(
        importViolations.every((v) => !v.file.endsWith("clean.ts")),
      ).toBe(true);
    });

    it("does NOT flag unrelated words that merely contain a banned substring", () => {
      // `resubmit` / `submitButton` must not false-positive — the match is
      // word-boundary scoped, not a raw substring search.
      const localDir = mkdtempSync(join(tmpdir(), "pythia-scan-fp-"));
      writeFileSync(
        join(localDir, "form.ts"),
        `export const resubmitCount = 0;\nexport function submitButtonLabel() { return "Go"; }\n`,
      );

      const violations = scanForBannedSymbols(localDir);
      expect(violations).toHaveLength(0);

      rmSync(localDir, { recursive: true, force: true });
    });
  });

  it("passes against the real service source — Pythia signs nothing and reaches no submit client", () => {
    // The keyless gateway relays caller-supplied payloads (read via /local,
    // broadcast via a plain fetch to /send) and reaches for none of the banned
    // signing/submit symbols, so the invariant holds against the real tree.
    const violations = scanForBannedSymbols(SERVICE_SRC);
    expect(violations).toEqual([]);
  });

  it("imports nothing from the write-capable @stoachain/stoa-core/network module", () => {
    // The import boundary: no Pythia module may import the sibling's network
    // module at all (it houses getFailoverClient / the write-capable client).
    const importViolations = scanForBannedImports(SERVICE_SRC);
    expect(importViolations).toEqual([]);
  });

  it("bans both the network module and the dirty reads barrel", () => {
    // Both sibling modules pull the signing/submit client (createClient /
    // getFailoverClient / pollOne), so both are on the banned-module roster. The
    // keyless gateway builds /local, /send, /poll and /cut over its own dial().
    expect([...BANNED_IMPORT_MODULES]).toContain("@stoachain/stoa-core/reads");
    expect([...BANNED_IMPORT_MODULES]).toContain("@stoachain/stoa-core/network");
  });

  it("imports nothing from the dirty @stoachain/stoa-core/reads barrel", () => {
    // Scanning the whole src tree (incl. reads/ + routes/) must find zero imports
    // of the dirty barrel — Pythia owns its transport over plain fetch.
    const importViolations = scanForBannedImports(SERVICE_SRC);
    expect(
      importViolations.filter((v) =>
        v.importPath.includes("@stoachain/stoa-core/reads"),
      ),
    ).toEqual([]);
  });

  it("imports nothing from @stoachain/* except the keyless dalos-crypto verify primitive", () => {
    // The keyless pivot dropped the sibling couplings. The ONE sanctioned exception
    // is `@stoachain/dalos-crypto/registry`, used SOLELY for `Apollo.verify` (pure
    // public-data signature check — no key, no sign; see apolloVerify.ts). Every
    // OTHER @stoachain specifier stays banned. This catches BOTH static
    // `from "@stoachain/…"` and dynamic `import("@stoachain/…")` — the latter is how
    // apolloVerify.ts loads the primitive, so the exception must be real, not a
    // regex blind spot. The scanner file enumerates names, so it is excluded.
    const ENFORCEMENT_FILES = new Set(["keylessScanner.ts"]);
    const ALLOWED = new Set(["@stoachain/dalos-crypto/registry"]);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts") && !ENFORCEMENT_FILES.has(basename(full))) {
          files.push(full);
        }
      }
    };
    walk(SERVICE_SRC);
    const specifier = /(?:from\s+|import\s*\(\s*)["'](@stoachain\/[^"']+)["']/g;
    const offenders: { file: string; module: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let m: RegExpExecArray | null;
      specifier.lastIndex = 0;
      while ((m = specifier.exec(src)) !== null) {
        if (!ALLOWED.has(m[1])) offenders.push({ file: f, module: m[1] });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches a banned module smuggled in via DYNAMIC import()", () => {
    // The dynamic form (`await import("…")`) previously evaded scanForBannedImports.
    // Prove it is now caught, so a lazy import of the write-capable network module
    // can't slip past the boundary.
    const dir = mkdtempSync(join(tmpdir(), "pythia-dynimport-"));
    writeFileSync(
      join(dir, "sneaky.ts"),
      `export async function x() {\n  const net = await import("@stoachain/stoa-core/network");\n  return net;\n}\n`,
    );
    const violations = scanForBannedImports(dir);
    expect(violations.map((v) => v.importPath)).toContain(
      "@stoachain/stoa-core/network",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
