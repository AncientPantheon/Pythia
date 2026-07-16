import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deploySpoolDir,
  deployMode,
  isValidDeployId,
  requestsDir,
  stateDir,
  requestPath,
  logPath,
  statusPath,
  readStatus,
  isTerminalStatus,
  seedDeployFiles,
} from "./spool.js";

// Every function reads PYTHIA_DEPLOY_DIR / NODE_ENV per call, so tests drive
// them through process.env and restore the originals afterwards.
const savedDeployDir = process.env.PYTHIA_DEPLOY_DIR;
const savedNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (savedDeployDir === undefined) delete process.env.PYTHIA_DEPLOY_DIR;
  else process.env.PYTHIA_DEPLOY_DIR = savedDeployDir;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe("deploySpoolDir — PYTHIA_DEPLOY_DIR env contract", () => {
  it("returns null when the env var is unset (dev mode)", () => {
    // Localhost dev has no spool volume; null is the signal that drives every
    // dev-mode branch (disabled Deploy button, 409 on POST).
    delete process.env.PYTHIA_DEPLOY_DIR;
    expect(deploySpoolDir()).toBeNull();
  });

  it("returns null for an empty or whitespace-only value", () => {
    // A mis-set `PYTHIA_DEPLOY_DIR=` in an env-file must not enable bundle mode
    // with an empty path (which would spool files into cwd).
    process.env.PYTHIA_DEPLOY_DIR = "";
    expect(deploySpoolDir()).toBeNull();
    process.env.PYTHIA_DEPLOY_DIR = "   ";
    expect(deploySpoolDir()).toBeNull();
  });

  it("returns the trimmed directory when set", () => {
    process.env.PYTHIA_DEPLOY_DIR = "  /data/deploy  ";
    expect(deploySpoolDir()).toBe("/data/deploy");
  });
});

describe("deployMode — bundle only with spool dir AND production", () => {
  it("is 'dev' when PYTHIA_DEPLOY_DIR is unset, even in production", () => {
    // A production container without the spool volume must not offer Deploy —
    // the request file would go nowhere.
    delete process.env.PYTHIA_DEPLOY_DIR;
    process.env.NODE_ENV = "production";
    expect(deployMode()).toBe("dev");
  });

  it("is 'dev' when the spool dir is set but NODE_ENV is not production", () => {
    // A developer pointing PYTHIA_DEPLOY_DIR at a scratch dir locally must not
    // flip the admin panel into bundle mode.
    process.env.PYTHIA_DEPLOY_DIR = "/data/deploy";
    process.env.NODE_ENV = "test";
    expect(deployMode()).toBe("dev");
  });

  it("is 'bundle' when both the spool dir and NODE_ENV=production are set", () => {
    process.env.PYTHIA_DEPLOY_DIR = "/data/deploy";
    process.env.NODE_ENV = "production";
    expect(deployMode()).toBe("bundle");
  });
});

describe("isValidDeployId — path-traversal guard", () => {
  it("accepts crypto.randomUUID() output", () => {
    // Deploy ids are minted with randomUUID(); the guard must never reject a
    // legitimate id or the SSE stream would 400 on every real deploy.
    expect(isValidDeployId(randomUUID())).toBe(true);
    expect(isValidDeployId("A1B2C3D4-e5f6-7890-abcd-ef0123456789")).toBe(true);
  });

  it("rejects path traversal, empty, and junk ids", () => {
    // The id is interpolated into file paths under the spool dir; anything but
    // hex-and-dashes could escape it (../evil → /data/evil.log).
    expect(isValidDeployId("../evil")).toBe(false);
    expect(isValidDeployId("")).toBe(false);
    expect(isValidDeployId("UPPER!:")).toBe(false);
    expect(isValidDeployId("abc/def-0123")).toBe(false);
    expect(isValidDeployId("a1b2c3")).toBe(false); // too short (< 8)
    expect(isValidDeployId("a".repeat(65))).toBe(false); // too long (> 64)
  });
});

describe("spool paths — requests/ vs state/ split", () => {
  it("puts the request in requests/ and the log+status in state/", () => {
    // FIX 1: the container (this process) may only write under requests/; root
    // owns state/. The host deployer globs these exact split paths, so a drift
    // in either subdir or suffix breaks the handshake silently.
    const base = mkdtempSync(join(tmpdir(), "pythia-spool-"));
    process.env.PYTHIA_DEPLOY_DIR = base;
    const id = "deadbeef-0000";
    expect(requestsDir()).toBe(join(base, "requests"));
    expect(stateDir()).toBe(join(base, "state"));
    expect(requestPath(id)).toBe(join(base, "requests", `${id}.request.json`));
    expect(logPath(id)).toBe(join(base, "state", `${id}.log`));
    expect(statusPath(id)).toBe(join(base, "state", `${id}.status`));
    rmSync(base, { recursive: true, force: true });
  });

  it("requestsDir/stateDir are null in dev mode (no spool base)", () => {
    // Dev has no spool volume; both derived dirs must be null so nothing tries
    // to mkdir/write into cwd.
    delete process.env.PYTHIA_DEPLOY_DIR;
    expect(requestsDir()).toBeNull();
    expect(stateDir()).toBeNull();
  });
});

describe("seedDeployFiles — request-only, root owns state/", () => {
  it("writes ONLY <id>.request.json into requests/ (atomic) and no log/status/state dir", () => {
    // FIX 1 security core: the container must NOT create the log or status —
    // those live in root-owned state/. If the container could plant a file (or
    // symlink) at state/<id>.log, root would later write through it. So seeding
    // touches requests/ only, and never creates state/.
    const base = mkdtempSync(join(tmpdir(), "pythia-spool-"));
    process.env.PYTHIA_DEPLOY_DIR = join(base, "deploy"); // not yet created — seed must mkdir -p requests/
    const id = randomUUID();
    const requestedAt = "2026-07-16T12:00:00.000Z";
    seedDeployFiles(id, { id, mode: "bundle", requestedAt });

    // The request JSON must arrive whole (atomic rename) — it is the path-unit trigger.
    expect(JSON.parse(readFileSync(requestPath(id), "utf8"))).toEqual({
      id,
      mode: "bundle",
      requestedAt,
    });
    // The container planted NOTHING in state/ — not the log, status, nor the dir.
    expect(existsSync(logPath(id))).toBe(false);
    expect(existsSync(statusPath(id))).toBe(false);
    expect(existsSync(stateDir()!)).toBe(false);
    // The atomic write must not leave its temp file behind.
    expect(existsSync(`${requestPath(id)}.tmp`)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("readStatus — reads root-written status from state/", () => {
  it("returns the trimmed one-word status and follows updates", () => {
    // The deployer (root) writes "running\n" / "success\n" into state/ with
    // trailing newlines; the SSE poller compares statuses, so the read must be
    // trimmed to one word. The test writes state/ itself (root's job).
    const base = mkdtempSync(join(tmpdir(), "pythia-spool-"));
    process.env.PYTHIA_DEPLOY_DIR = base;
    const id = randomUUID();
    mkdirSync(stateDir()!, { recursive: true });
    writeFileSync(statusPath(id), "running\n");
    expect(readStatus(id)).toBe("running");
    writeFileSync(statusPath(id), "success\n");
    expect(readStatus(id)).toBe("success");
    rmSync(base, { recursive: true, force: true });
  });

  it("returns null when the status file does not exist", () => {
    // Streaming an unknown/expired id must degrade to null, not throw into the
    // route handler.
    const base = mkdtempSync(join(tmpdir(), "pythia-spool-"));
    process.env.PYTHIA_DEPLOY_DIR = base;
    expect(readStatus(randomUUID())).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
});

describe("isTerminalStatus", () => {
  it("is true only for success and failed", () => {
    // The SSE loop closes on a terminal status; treating "running" as terminal
    // would cut the log mid-deploy, and missing "failed" would hang the stream.
    expect(isTerminalStatus("success")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });
});
