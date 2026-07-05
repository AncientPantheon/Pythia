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
    // These five are the signing/submit-client surface the keyless gateway must
    // never reach — Pythia never signs; it relays caller-signed payloads.
    expect([...BANNED_BROADCAST_SYMBOLS].sort()).toEqual(
      ["createClient", "getFailoverClient", "listen", "pollOne", "submit"].sort(),
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

  it("imports NOTHING from any @stoachain/* module — the gateway is self-contained", () => {
    // The keyless pivot dropped the last @stoachain couplings (the decode-baked
    // balance reads). Pythia now depends on no sibling package at all; every real
    // source module must carry zero @stoachain import specifiers. The scanner file
    // and this invariant test enumerate the names in fixtures/comments, so they
    // are excluded as the enforcement mechanism, not transport code.
    const ENFORCEMENT_FILES = new Set(["keylessScanner.ts"]);
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
    const offenders = files.filter((f) =>
      /from\s+["']@stoachain\//.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
