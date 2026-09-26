import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PACT_NAMESPACE,
  PYTHIA_NAMES,
  PYTHIA_QUALIFIED,
  pythiaFn,
  pythiaNameKeys,
  pythiaRead,
} from "./names.js";

const here = dirname(fileURLToPath(import.meta.url));
const frontendMirror = join(here, "..", "..", "public", "pact-names.js");

describe("Pact name inventory", () => {
  it("walks every key and yields a well-formed qualified call", () => {
    for (const key of pythiaNameKeys()) {
      const spec = PYTHIA_NAMES[key];
      const args = Array.from({ length: spec.arity }, (_, i) => String(i));
      const code = pythiaRead(key, args);
      expect(code.startsWith(`(${PYTHIA_QUALIFIED}.${spec.fn}`)).toBe(true);
      expect(code.endsWith(")")).toBe(true);
    }
  });

  it("BANS the URD_ family — it is dead on the deployed module (2026-09 redeploy)", () => {
    // The v3.0.2 outage and the 2026-09 frontend outage were both a URD_ name that had been
    // renamed to URH_. Nothing may reintroduce one.
    for (const key of pythiaNameKeys()) {
      expect(pythiaFn(key)).not.toMatch(/^URD_/);
    }
  });

  it("also bans UR_ActiveDualLinkSet — the round-one name that never existed at all", () => {
    for (const key of pythiaNameKeys()) {
      expect(pythiaFn(key)).not.toBe("UR_ActiveDualLinkSet");
    }
  });

  it("refuses to build a short call (Pact would partially apply it, not error)", () => {
    expect(() => pythiaRead("pythDay", [])).toThrow(/takes 1 argument/);
    expect(() => pythiaRead("listAllDualLinks", ["7"])).toThrow(/takes 0 argument/);
  });

  it("every name records the call site that would go silent without it", () => {
    for (const key of pythiaNameKeys()) {
      expect(PYTHIA_NAMES[key].usedBy.length).toBeGreaterThan(10);
    }
  });

  it("the frontend mirror has not drifted from the TypeScript inventory", () => {
    const src = readFileSync(frontendMirror, "utf8");

    // Namespace + module must agree.
    expect(src).toContain(`export const PACT_NAMESPACE = "${PACT_NAMESPACE}";`);

    // Parse the mirror's PYTHIA_FN / PYTHIA_ARITY blocks and compare key-by-key.
    const block = (name: string): Record<string, string> => {
      const m = src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`));
      if (!m) throw new Error(`${name} block not found in public/pact-names.js`);
      const out: Record<string, string> = {};
      for (const line of m[1].split("\n")) {
        const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*"?([^",]+)"?,?\s*$/);
        if (kv) out[kv[1]] = kv[2];
      }
      return out;
    };

    const mirrorFn = block("PYTHIA_FN");
    const mirrorArity = block("PYTHIA_ARITY");
    const expectedFn = Object.fromEntries(pythiaNameKeys().map((k) => [k, PYTHIA_NAMES[k].fn]));
    const expectedArity = Object.fromEntries(
      pythiaNameKeys().map((k) => [k, String(PYTHIA_NAMES[k].arity)]),
    );

    expect(mirrorFn).toEqual(expectedFn);
    expect(mirrorArity).toEqual(expectedArity);
  });

  it("no source file outside the inventory hardcodes the namespace", async () => {
    // The three `const PYTHIA_NS = "ouronet-ns"` aliases are exactly how a literal-only scan
    // missed call sites. Nothing but names.ts may SPELL it in executable code.
    //
    // Comment lines are stripped before matching: the incident docstrings in dualLinkCache.ts
    // legitimately quote the dead names, and chasing prose mentions is its own trap.
    const { execSync } = await import("node:child_process");
    const root = join(here, "..");
    const files = execSync(`grep -rl '${PACT_NAMESPACE}' --include=*.ts ${root} || true`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.replace(root + "/", "");
      if (rel.startsWith("pact/") || rel.endsWith(".test.ts")) continue;
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      if (code.includes(PACT_NAMESPACE)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
