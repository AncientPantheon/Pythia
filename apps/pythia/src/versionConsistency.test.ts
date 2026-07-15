import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PYTHIA_VERSION } from "./version.js";

// The versioning gate (see docs/RELEASING.md): one tag ships two artifacts
// (the npm client + the ghcr image), so their version must never drift. This
// test fails if the root package.json, either workspace package.json, the
// version.ts constant, or the newest CHANGELOG.md entry disagree.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readPackageVersion(...segments: string[]): string {
  const pkg = JSON.parse(readFileSync(join(root, ...segments), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** The version of the newest `## [x.y.z]` heading in root CHANGELOG.md. */
function latestChangelogVersion(): string | null {
  const md = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const m = md.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}

describe("version consistency — one tag, one version, five agreeing sources", () => {
  const rootVersion = readPackageVersion("package.json");
  const clientVersion = readPackageVersion("packages", "pythia-client", "package.json");
  const appVersion = readPackageVersion("apps", "pythia", "package.json");
  const changelogVersion = latestChangelogVersion();

  it("every source is a clean SemVer x.y.z", () => {
    for (const v of [rootVersion, clientVersion, appVersion, PYTHIA_VERSION]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(
      changelogVersion,
      "root CHANGELOG.md must have a `## [x.y.z]` entry",
    ).not.toBeNull();
    expect(changelogVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("root package.json, both workspace package.json files, version.ts, and the newest CHANGELOG entry all agree", () => {
    expect(
      { root: rootVersion, client: clientVersion, app: appVersion, versionTs: PYTHIA_VERSION, changelog: changelogVersion },
      "a version bump must update root package.json, packages/pythia-client/package.json, apps/pythia/package.json, apps/pythia/src/version.ts, and add a matching CHANGELOG.md entry — see docs/RELEASING.md",
    ).toEqual({
      root: rootVersion,
      client: rootVersion,
      app: rootVersion,
      versionTs: rootVersion,
      changelog: rootVersion,
    });
  });
});
