import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerResolver } from "@ancientpantheon/khronoton-core/server";
import { PythLedger } from "../../pyth/ledger.js";
import {
  PYTH_FLUSH_RESOLVER,
  createPythFlushResolver,
  registerPythFlushResolver,
} from "./pythFlushResolver.js";

const tmp: string[] = [];
function ledgerAt(iso: string): PythLedger {
  const dir = mkdtempSync(join(tmpdir(), "pyth-flush-"));
  tmp.push(dir);
  return new PythLedger({ filePath: join(dir, "l.json"), flushMs: 0, clock: () => new Date(iso) });
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("pyth-flush server resolver", () => {
  it("resolve() fills the `entries` payload from the ledger + carries a drain token", () => {
    const l = ledgerAt("2026-07-23T08:00:00.000Z");
    l.recordRead(10);
    const r = createPythFlushResolver(l);
    const { payload, plan } = r.resolve();
    const entries = payload.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].day).toBe(3);
    expect(entries[0]["iz-complete"]).toBe(false);
    expect(entries[0].petitions).toBe(1);
    expect(plan).toHaveLength(1); // the token, forwarded to settle
  });

  it("settle() drains the ledger (confirmed-success path)", () => {
    const l = ledgerAt("2026-07-23T08:00:00.000Z");
    l.recordRead(10);
    const r = createPythFlushResolver(l);
    const { plan } = r.resolve();
    expect(l.total().petitions).toBe(1); // resolve did not mutate
    r.settle(plan);
    expect(l.total().petitions).toBe(0); // settled → drained
  });

  it("registers under the canonical `pyth-flush` name for the tick to find", () => {
    const l = ledgerAt("2026-07-23T08:00:00.000Z");
    registerPythFlushResolver(l);
    const reg = getServerResolver(PYTH_FLUSH_RESOLVER);
    expect(reg?.kind).toBe("single-tx");
  });
});
