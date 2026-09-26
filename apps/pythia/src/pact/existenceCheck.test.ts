import { describe, it, expect } from "vitest";
import {
  checkPactNamesExist,
  declaresMember,
  formatExistenceReport,
} from "./existenceCheck.js";
import { PYTHIA_NAMES, pythiaNameKeys } from "./names.js";
import type { NodePool } from "../pool/nodePool.js";
import type { DialNode } from "../dial/index.js";

const FAKE_POOL = {
  pickReadPair: () => ({
    primary: { id: "n1", url: "https://n1.example" } as DialNode,
    fallback: { id: "n2", url: "https://n2.example" } as DialNode,
  }),
} as unknown as NodePool;

const NO_NODES = { pickReadPair: () => null } as unknown as NodePool;

/** A node answering `describe-module` with the given deployed source. */
function fakeDescribe(code: string, hash = "MODHASH") {
  return async () =>
    new Response(JSON.stringify({ result: { status: "success", data: { code, hash } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** Deployed source declaring every name the inventory currently holds. */
function healthySource(): string {
  return pythiaNameKeys()
    .map((k) => `    (defun ${PYTHIA_NAMES[k].fn}:[object] ()\n      @doc "x"\n      true)`)
    .join("\n");
}

describe("declaresMember", () => {
  it("matches a defun with the house-style return annotation", () => {
    expect(declaresMember('(defun URH_ListAllDualLinks:[object] ()', "URH_ListAllDualLinks")).toBe(true);
  });

  it("matches a plain defun and a defcap", () => {
    expect(declaresMember("(defun UR_Public (a)", "UR_Public")).toBe(true);
    expect(declaresMember("(defcap SECURE ()", "SECURE")).toBe(true);
  });

  it("does NOT let a docstring mention vouch for a name that is gone", () => {
    // This is precisely how the last two rounds looked plausible: the dead name was all over
    // the prose while absent from the module.
    const code = '(defun URH_ListActiveDualLinks:[object] ()\n  @doc "replaces URD_ListActiveDualLinks")';
    expect(declaresMember(code, "URD_ListActiveDualLinks")).toBe(false);
    expect(declaresMember(code, "URH_ListActiveDualLinks")).toBe(true);
  });

  it("does not match a name that merely prefixes a real one", () => {
    expect(declaresMember("(defun UR_PythDayRange ()", "UR_PythDay")).toBe(false);
  });
});

describe("checkPactNamesExist", () => {
  it("passes when the deployed module declares every inventory name", async () => {
    const report = await checkPactNamesExist(FAKE_POOL, fakeDescribe(healthySource()));
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.moduleHash).toBe("MODHASH");
  });

  it("names the dead symbol AND its call site when one is missing", async () => {
    // Simulate the real 2026-09 redeploy: URH_ListActiveDualLinks removed.
    const code = healthySource().replace(/\(defun URH_ListActiveDualLinks[^\n]*\n[^\n]*\n[^\n]*/, "");
    const report = await checkPactNamesExist(FAKE_POOL, fakeDescribe(code));
    expect(report.ok).toBe(false);
    expect(report.missing.map((m) => m.fn)).toContain("URH_ListActiveDualLinks");

    const msg = formatExistenceReport(report);
    expect(msg).toContain("URH_ListActiveDualLinks");
    expect(msg).toContain("dualLinkCache.ts"); // the call site, not just the name
    expect(msg).toContain("FAIL-CLOSED");
  });

  it("reports UNVERIFIED (not missing) when the chain cannot be read", async () => {
    // A transient node failure must never be reported as a dead name.
    const report = await checkPactNamesExist(NO_NODES);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.unreachable).toBe("no read node available");
    expect(formatExistenceReport(report)).toContain("UNVERIFIED");
  });

  it("reports UNVERIFIED when describe-module itself errors", async () => {
    const failing = async () =>
      new Response(
        JSON.stringify({ result: { status: "failure", error: { message: "boom" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await checkPactNamesExist(FAKE_POOL, failing);
    expect(report.unreachable).toBe("boom");
    expect(report.missing).toEqual([]);
  });
});
