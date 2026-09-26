import { describe, it, expect } from "vitest";
import { pactSurface, recordPactExistence } from "./surface.js";
import type { PactExistenceReport } from "./existenceCheck.js";

const OK: PactExistenceReport = { ok: true, moduleHash: "H1", missing: [], unreachable: null };

describe("pactSurface (/healthz contract-surface identity)", () => {
  it("reports the INSTALLED talos-registry version and its surfaceHash", () => {
    recordPactExistence(OK);
    const s = pactSurface();
    // Read from node_modules on disk, so it cannot claim a version that is not installed.
    expect(s.talosVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(s.talosSurfaceHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("carries the deployed module hash — the value that changes on ANY redeploy", () => {
    recordPactExistence(OK);
    expect(pactSurface()).toMatchObject({ pythiaModuleHash: "H1", namesStatus: "ok" });
  });

  it("names the dead symbols when the boot check found some", () => {
    recordPactExistence({
      ok: false,
      moduleHash: "H2",
      missing: [
        { key: "listActiveDualLinks", fn: "URH_ListActiveDualLinks", usedBy: "dualLinkCache.ts" },
      ],
      unreachable: null,
    });
    const s = pactSurface();
    expect(s.namesStatus).toBe("dead-names");
    expect(s.deadNames).toEqual(["URH_ListActiveDualLinks"]);
  });

  it("distinguishes UNVERIFIED (chain unreachable) from dead names", () => {
    // A transient node failure must not be reported as a rename.
    recordPactExistence({ ok: false, moduleHash: null, missing: [], unreachable: "no read node" });
    const s = pactSurface();
    expect(s.namesStatus).toBe("unverified");
    expect(s.deadNames).toBeUndefined();
  });
});
