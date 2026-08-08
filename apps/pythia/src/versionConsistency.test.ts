import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PYTHIA_VERSION } from "./version.js";

// The versioning gate (see docs/RELEASING.md). TWO INDEPENDENT version lines:
//
//   • SERVICE — the tag `vX.Y.Z` + root package.json + apps/pythia/package.json +
//     apps/pythia/src/version.ts + the top root CHANGELOG entry. All lockstep — they
//     ARE the one service (the gateway/website image). The tag is the service version.
//
//   • CLIENT — @ancientpantheon/pythia-client: its package.json + its CHANGELOG top +
//     its README status line. INDEPENDENT of the service — bumped ONLY when the client's
//     own source changes, otherwise it stays put while the service moves on. So a
//     service-only release does NOT touch (or republish) the client.
//
// This test enforces each line's INTERNAL consistency; it deliberately does NOT require
// the client to equal the service.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readPackageVersion(...segments: string[]): string {
  const pkg = JSON.parse(readFileSync(join(root, ...segments), "utf8")) as { version: string };
  return pkg.version;
}
/** Newest `## [x.y.z]` heading in the ROOT CHANGELOG (service). */
function rootChangelogVersion(): string | null {
  const m = readFileSync(join(root, "CHANGELOG.md"), "utf8").match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}
/** Newest `## x.y.z` heading in the CLIENT CHANGELOG. */
function clientChangelogVersion(): string | null {
  const md = readFileSync(join(root, "packages", "pythia-client", "CHANGELOG.md"), "utf8");
  const m = md.match(/^##\s*(\d+\.\d+\.\d+)\s/m);
  return m ? m[1] : null;
}
/** The `` `x.y.z` on public npmjs `` status line in the CLIENT README. */
function clientReadmeVersion(): string | null {
  const md = readFileSync(join(root, "packages", "pythia-client", "README.md"), "utf8");
  const m = md.match(/`(\d+\.\d+\.\d+)`\s+on public npmjs/);
  return m ? m[1] : null;
}

describe("version consistency — service quartet in lockstep; client independent", () => {
  const rootVersion = readPackageVersion("package.json");
  const appVersion = readPackageVersion("apps", "pythia", "package.json");
  const clientVersion = readPackageVersion("packages", "pythia-client", "package.json");
  const rootChangelog = rootChangelogVersion();
  const clientChangelog = clientChangelogVersion();
  const clientReadme = clientReadmeVersion();

  it("every version source is clean SemVer x.y.z", () => {
    for (const v of [rootVersion, appVersion, PYTHIA_VERSION, clientVersion]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
    for (const [name, v] of [
      ["root CHANGELOG", rootChangelog],
      ["client CHANGELOG", clientChangelog],
      ["client README status", clientReadme],
    ] as const) {
      expect(v, `${name} must carry a clean x.y.z version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("the SERVICE quartet agrees (root pkg, app pkg, version.ts, root CHANGELOG)", () => {
    expect(
      { root: rootVersion, app: appVersion, versionTs: PYTHIA_VERSION, changelog: rootChangelog },
      "a SERVICE bump must update root package.json, apps/pythia/package.json, apps/pythia/src/version.ts, and add a matching root CHANGELOG.md entry — see docs/RELEASING.md",
    ).toEqual({ root: rootVersion, app: rootVersion, versionTs: rootVersion, changelog: rootVersion });
  });

  it("the CLIENT is internally consistent (pkg, its CHANGELOG, its README) — INDEPENDENT of the service", () => {
    expect(
      { pkg: clientVersion, changelog: clientChangelog, readme: clientReadme },
      "a CLIENT bump must update packages/pythia-client/{package.json,CHANGELOG.md,README.md} together — and ONLY when the client's own source changes — see docs/RELEASING.md",
    ).toEqual({ pkg: clientVersion, changelog: clientVersion, readme: clientVersion });
  });

  it("does NOT require the client to equal the service (the two lines may diverge)", () => {
    // A service-only release leaves the client behind; this must remain valid. The two
    // preceding assertions check each line's OWN consistency, never client === service.
    expect(typeof clientVersion).toBe("string");
    expect(typeof rootVersion).toBe("string");
  });
});
