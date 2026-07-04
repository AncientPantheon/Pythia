import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  BANNED_BROADCAST_SYMBOLS,
  BANNED_IMPORT_MODULES,
  scanForBannedSymbols,
  scanForBannedImports,
} from "../src/invariants/readOnlyScanner.js";

const SERVICE_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

describe("read-only invariant scanner", () => {
  it("exposes the exact banned broadcast/signing symbol list", () => {
    // These five are the transport/signing surface the service must never reach.
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
      // import of that module at all, since it is the write-capable transport surface.
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

  it("passes against the real service source now that real transport code exists", () => {
    // Phase 2 landed the dial/relay/health transport over plain fetch. Pythia
    // owns its transport and reaches for none of the banned broadcast symbols,
    // so the invariant still holds against the real tree.
    const violations = scanForBannedSymbols(SERVICE_SRC);
    expect(violations).toEqual([]);
  });

  it("imports nothing from the write-capable @stoachain/stoa-core/network module", () => {
    // The import boundary: no Pythia module may import the sibling's network
    // module at all (it houses getFailoverClient / the write-capable client).
    const importViolations = scanForBannedImports(SERVICE_SRC);
    expect(importViolations).toEqual([]);
  });

  it("bans the dirty reads barrel while leaving the pure pact subpath allowed", () => {
    // @stoachain/stoa-core/reads pulls createClient + getFailoverClient/pollOne
    // (the banned wrapper path), so it is on the banned-module roster. The pure
    // @stoachain/stoa-core/pact subpath (mayComeWithDeimal) must NOT be banned —
    // it is the one sibling module Pythia's reads legitimately import.
    expect([...BANNED_IMPORT_MODULES]).toContain("@stoachain/stoa-core/reads");
    expect([...BANNED_IMPORT_MODULES]).toContain("@stoachain/stoa-core/network");
    expect([...BANNED_IMPORT_MODULES]).not.toContain("@stoachain/stoa-core/pact");
  });

  it("imports nothing from the dirty @stoachain/stoa-core/reads barrel", () => {
    // The Phase-3 read modules build /local, /poll and /cut over Pythia's own
    // dial() — never the sibling's read wrappers. Scanning the whole src tree
    // (incl. reads/ + routes/getBalance.ts + routes/getConfirmations.ts) must
    // find zero imports of the dirty barrel.
    const importViolations = scanForBannedImports(SERVICE_SRC);
    expect(
      importViolations.filter((v) =>
        v.importPath.includes("@stoachain/stoa-core/reads"),
      ),
    ).toEqual([]);
  });

  it("DOES import the pure @stoachain/stoa-core/pact decoder in the reads layer", () => {
    // Pins the reuse-vs-replicate decision: the decode helper mayComeWithDeimal
    // is reused from the clean subpath, and the dirty /reads barrel is never
    // swapped in for it. A future edit that replaced pact with reads would drop
    // this positive import and fail here.
    const readsDir = join(SERVICE_SRC, "reads");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
          files.push(full);
        }
      }
    };
    walk(readsDir);
    const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
    // Match an actual ESM import specifier, not a mere comment mention, so the
    // assertion fails if the decoder is referenced only in prose but never wired.
    expect(source).toMatch(/from\s+["']@stoachain\/stoa-core\/pact["']/);
    expect(source).not.toMatch(/from\s+["']@stoachain\/stoa-core\/reads["']/);
  });
});
