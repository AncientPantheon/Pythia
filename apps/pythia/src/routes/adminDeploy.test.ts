import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminDeploy, DEFAULT_MAX_STREAM_MS } from "./adminDeploy.js";
import { signSession } from "../admin/session.js";
import type { OidcConfig } from "../admin/oidcConfig.js";
import { PYTHIA_VERSION } from "../version.js";
import {
  isValidDeployId,
  logPath,
  requestPath,
  seedDeployFiles,
  stateDir,
  statusPath,
} from "../deploy/spool.js";

const secret = "unit-test-session-secret-at-least-32-chars";

function buildApp(
  deps: { pollMs?: number; maxStreamMs?: number; startDevUpdate?: (id: string) => void } = {},
): Hono {
  const app = new Hono();
  registerAdminDeploy(app, { sessionSecret: secret } as OidcConfig, deps);
  return app;
}

async function cookieFor(roles: string[]): Promise<string> {
  return `pythia_admin_session=${await signSession(
    { sub: "u1", roles, name: "Tester" },
    secret,
  )}`;
}

// The routes read PYTHIA_DEPLOY_DIR / NODE_ENV / PYTHIA_COLOR / PORT per
// request, so tests drive them through process.env and restore the originals.
const savedEnv: Record<string, string | undefined> = {
  PYTHIA_DEPLOY_DIR: process.env.PYTHIA_DEPLOY_DIR,
  PYTHIA_DEV_DEPLOY_DIR: process.env.PYTHIA_DEV_DEPLOY_DIR,
  NODE_ENV: process.env.NODE_ENV,
  PYTHIA_COLOR: process.env.PYTHIA_COLOR,
  PORT: process.env.PORT,
};
const tempDirs: string[] = [];

function devEnv(): void {
  delete process.env.PYTHIA_DEPLOY_DIR;
  process.env.NODE_ENV = "test";
  delete process.env.PYTHIA_COLOR;
  delete process.env.PORT;
}

function bundleEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), "pythia-deploy-route-"));
  tempDirs.push(dir);
  process.env.PYTHIA_DEPLOY_DIR = dir;
  process.env.NODE_ENV = "production";
  return dir;
}

// FIX 1: the container (seedDeployFiles) only drops the request; the log and
// status live in the root-owned state/ dir. Tests simulate root by writing
// state/ directly (creating the dir the container is forbidden from touching).
function rootWriteState(id: string, opts: { status: string; log?: string }): void {
  mkdirSync(stateDir()!, { recursive: true });
  if (opts.log !== undefined) writeFileSync(logPath(id), opts.log);
  writeFileSync(statusPath(id), opts.status);
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ancient gate on every deploy route", () => {
  // The deploy surface triggers a root-privileged rebuild of the box; an
  // unauthenticated or non-ancient caller reaching ANY of these routes would be
  // a privilege-escalation hole, so each one must sit behind the shared gate.
  it("401s all three routes when no session cookie is present", async () => {
    devEnv();
    const app = buildApp();
    for (const [method, path] of [
      ["GET", "/api/admin/deploy/status"],
      ["POST", "/api/admin/deploy"],
      ["GET", `/api/admin/deploy/stream/${randomUUID()}`],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("403s a valid session that lacks the ancient role", async () => {
    devEnv();
    const app = buildApp();
    const cookie = await cookieFor(["modern"]);
    for (const [method, path] of [
      ["GET", "/api/admin/deploy/status"],
      ["POST", "/api/admin/deploy"],
      ["GET", `/api/admin/deploy/stream/${randomUUID()}`],
    ] as const) {
      const res = await app.request(path, { method, headers: { cookie } });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe("GET /api/admin/deploy/status", () => {
  it("reports dev mode with null color/port/container on a dev box, uncached", async () => {
    // The panel disables the Deploy button off this shape; a cached or wrong
    // dev report would offer a deploy that can only 409.
    devEnv();
    const app = buildApp();
    const res = await app.request("/api/admin/deploy/status", {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      mode: "dev",
      color: null,
      port: null,
      version: PYTHIA_VERSION,
      container: null,
      active: null,
    });
  });

  it("reports the live color, port, and derived container name in bundle mode", async () => {
    // Blue-green ops depend on this readout: pythia-<color> is the exact
    // container name the deployer manages, so the derivation must match.
    bundleEnv();
    process.env.PYTHIA_COLOR = "green";
    process.env.PORT = "8081";
    const app = buildApp();
    const res = await app.request("/api/admin/deploy/status", {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(await res.json()).toEqual({
      mode: "bundle",
      color: "green",
      port: "8081",
      version: PYTHIA_VERSION,
      container: "pythia-green",
      active: null,
    });
  });

  it("surfaces a running deploy as `active` (so the panel can auto-attach)", async () => {
    bundleEnv();
    const id = randomUUID();
    rootWriteState(id, { status: "running", log: "▶ started\n" });
    const app = buildApp();
    const body = (await (
      await app.request("/api/admin/deploy/status", { headers: { cookie: await cookieFor(["ancient"]) } })
    ).json()) as { active: { id: string; status: string; startedAt: string } | null };
    expect(body.active?.id).toBe(id);
    expect(body.active?.status).toBe("running");
    expect(typeof body.active?.startedAt).toBe("string");
  });

  it("does not surface a finished deploy as active", async () => {
    bundleEnv();
    const id = randomUUID();
    rootWriteState(id, { status: "success", log: "✓ done\n" });
    const app = buildApp();
    const body = (await (
      await app.request("/api/admin/deploy/status", { headers: { cookie: await cookieFor(["ancient"]) } })
    ).json()) as { active: unknown };
    expect(body.active).toBeNull();
  });
});

describe("POST /api/admin/deploy", () => {
  it("in dev mode starts the constructor update instead of a blue-green deploy", async () => {
    // Dev has no spool volume / docker / Caddy, so Deploy pulls the automaton
    // organs at @latest instead — and must never touch a spool path.
    devEnv();
    const started: string[] = [];
    const app = buildApp({ startDevUpdate: (id) => started.push(id) });
    const res = await app.request("/api/admin/deploy", {
      method: "POST",
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; mode: string };
    expect(body.mode).toBe("dev");
    expect(started).toEqual([body.id]); // the update ran for exactly this id
  });

  it("mints a uuid and drops ONLY the request file (no state/) in bundle mode", async () => {
    // This IS the deploy trigger: the host path-unit fires on the request file.
    // FIX 1: the container writes ONLY requests/<id>.request.json — it must not
    // create the log or status (root owns state/), so it never plants a symlink
    // there for root to write through.
    bundleEnv();
    const app = buildApp();
    const res = await app.request("/api/admin/deploy", {
      method: "POST",
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; mode: string };
    expect(body.mode).toBe("bundle");
    expect(isValidDeployId(body.id)).toBe(true);
    expect(existsSync(requestPath(body.id))).toBe(true);
    // The container planted nothing in the root-owned state/ dir.
    expect(existsSync(logPath(body.id))).toBe(false);
    expect(existsSync(statusPath(body.id))).toBe(false);
    expect(existsSync(stateDir()!)).toBe(false);
    const request = JSON.parse(readFileSync(requestPath(body.id), "utf8")) as {
      id: string;
      mode: string;
      requestedAt: string;
    };
    expect(request.id).toBe(body.id);
    expect(request.mode).toBe("bundle");
    expect(new Date(request.requestedAt).getTime()).not.toBeNaN();
  });
});

describe("GET /api/admin/deploy/stream/:id", () => {
  it("400s a path-traversal id before touching the filesystem", async () => {
    // The id is interpolated into spool paths; '../evil' reaching logPath would
    // tail an arbitrary file on the data volume.
    bundleEnv();
    const app = buildApp();
    const res = await app.request("/api/admin/deploy/stream/..%2Fevil", {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("in dev mode tails the constructor-update log and closes on its terminal status", async () => {
    // Dev streams the npm/rebuild output through the SAME contract as the host
    // deployer, so the progress display (pacman/timer/auto-reload) works locally too.
    devEnv();
    const devDir = mkdtempSync(join(tmpdir(), "pythia-devdeploy-"));
    tempDirs.push(devDir);
    process.env.PYTHIA_DEV_DEPLOY_DIR = devDir;
    const id = randomUUID();
    writeFileSync(join(devDir, `${id}.log`), "▶ dev constructor update\nadded 2 packages\n");
    writeFileSync(join(devDir, `${id}.status`), "success");

    const app = buildApp({ pollMs: 10 });
    const res = await app.request(`/api/admin/deploy/stream/${id}`, {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("dev constructor update"); // the log was tailed
    expect(text).toContain("event: done");
    expect(text).toContain("data: success");
  });

  it("replays the existing log, emits the status change, and closes on terminal status", async () => {
    // The whole point of the SSE terminal: the operator sees the build log and
    // the stream ENDS on success/failed instead of hanging the browser tab.
    bundleEnv();
    const id = randomUUID();
    seedDeployFiles(id, { id, mode: "bundle", requestedAt: new Date().toISOString() });
    // Root's job: write the log + terminal status into state/.
    rootWriteState(id, { status: "success\n", log: "step 1: git fetch\nstep 2: docker build\n" });

    const app = buildApp({ pollMs: 10 });
    const res = await app.request(`/api/admin/deploy/stream/${id}`, {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text(); // resolves only when the stream closes
    expect(text).toContain("step 1: git fetch");
    expect(text).toContain("step 2: docker build");
    expect(text).toContain("event: status");
    expect(text).toContain("event: done");
    expect(text).toContain("data: success");
  }, 10_000);

  it("closes at the hard cap when the deploy never reaches a terminal status", async () => {
    // A wedged deployer must not pin an SSE connection open forever; the cap
    // (20 min in production, shrunk here) guarantees the stream ends.
    bundleEnv();
    const id = randomUUID();
    seedDeployFiles(id, { id, mode: "bundle", requestedAt: new Date().toISOString() });
    // Root wrote a log header and left status "queued" — never terminal.
    rootWriteState(id, { status: "queued\n", log: `=== deploy ${id} ===\n` });

    const app = buildApp({ pollMs: 10, maxStreamMs: 80 });
    const res = await app.request(`/api/admin/deploy/stream/${id}`, {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    const text = await res.text(); // resolving at all proves the cap closed it
    expect(text).toContain(`deploy ${id}`); // the root-written log header was replayed
    expect(text).not.toContain("event: done");
  }, 10_000);

  it("tails INCREMENTALLY: streams later-appended chunks and a live status transition", async () => {
    // FIX 4: the terminal-path tests never exercise the poll loop's incremental
    // tail — status is already terminal when the stream opens. Here the stream
    // opens while status is "queued" with an empty log, then root appends two
    // log chunks across poll intervals and flips queued→running→success. The
    // stream must deliver BOTH chunks as separate data frames and emit a status
    // transition before the final done — proving the byte-offset tail advances.
    bundleEnv();
    const id = randomUUID();
    seedDeployFiles(id, { id, mode: "bundle", requestedAt: new Date().toISOString() });
    rootWriteState(id, { status: "queued\n", log: "" }); // in flight, nothing built yet

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const app = buildApp({ pollMs: 10 });
    const res = await app.request(`/api/admin/deploy/stream/${id}`, {
      headers: { cookie: await cookieFor(["ancient"]) },
    });
    expect(res.status).toBe(200);

    // Drive root's writes AFTER the request is in flight, spaced across polls so
    // each lands in a distinct poll cycle (pollMs=10).
    const writer = (async () => {
      await delay(30);
      appendFileSync(logPath(id), "chunk-A: fetching source\n");
      writeFileSync(statusPath(id), "running\n");
      await delay(40);
      appendFileSync(logPath(id), "chunk-B: building image\n");
      writeFileSync(statusPath(id), "success\n");
    })();

    const text = await res.text(); // resolves on the terminal 'done'
    await writer;

    const aIdx = text.indexOf("chunk-A: fetching source");
    const bIdx = text.indexOf("chunk-B: building image");
    const doneIdx = text.indexOf("event: done");
    // Both appended chunks were tailed, in order.
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    // Separate deliveries: a status transition landed BETWEEN the two chunks,
    // proving they arrived in different poll cycles (not one bulk read).
    expect(text.slice(aIdx, bIdx)).toContain("event: status");
    // A status transition precedes the final done.
    expect(text.indexOf("event: status")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("event: status")).toBeLessThan(doneIdx);
    expect(text).toContain("data: success");
    expect(doneIdx).toBeGreaterThan(bIdx);
  }, 10_000);
});

describe("DEFAULT_MAX_STREAM_MS — the production hard-cap default", () => {
  it("is exactly 20 minutes (1_200_000 ms)", () => {
    // FIX 5: the 20-min cap is the guarantee a wedged deployer can't pin an SSE
    // connection open forever; it is the default when deps.maxStreamMs is unset,
    // so a drift here silently changes the production timeout.
    expect(DEFAULT_MAX_STREAM_MS).toBe(1_200_000);
  });
});
