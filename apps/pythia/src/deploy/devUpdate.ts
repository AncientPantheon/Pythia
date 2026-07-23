import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The **dev-mode** counterpart of the on-box deploy. Localhost has no docker, no Caddy
 * and no host deployer, so the blue-green path can't run there — but a developer still
 * needs to pull a newly published constructor. In dev, Deploy therefore installs the
 * automaton organs at `@latest` and rebuilds the admin islands (mirroring Mnemosyne,
 * whose dev Deploy "pulls the constructors at @latest").
 *
 * It writes `<id>.log` + `<id>.status` in the SAME contract the host deployer uses, so
 * the SSE tail + the whole progress display (pacman, timer, auto-reload) work unchanged —
 * including a heartbeat line every ~6s, per the always-moving canonical rule.
 */

/** The organ packages a dev update pulls. */
export const DEV_CONSTRUCTORS = [
  "@ancientpantheon/codex@latest",
  "@ancientpantheon/khronoton-core@latest",
] as const;

/** Where dev update logs live (overridable; defaults under the OS temp dir). */
export function devDeployDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PYTHIA_DEV_DEPLOY_DIR?.trim();
  return raw && raw !== "" ? raw : join(tmpdir(), "pythia-dev-deploy");
}

export function devLogPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(devDeployDir(env), `${id}.log`);
}

export function devStatusPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(devDeployDir(env), `${id}.status`);
}

export function readDevStatus(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return readFileSync(devStatusPath(id, env), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Walk up from `start` to the workspace root (the package.json declaring `workspaces`),
 * so the install runs where `-w @ancientpantheon/pythia` resolves. Falls back to `start`.
 */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        /* unreadable — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export interface DevUpdateOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable spawner (tests). Defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
}

/**
 * Kick off the dev constructor update. Returns immediately; progress lands in the log
 * and the terminal status in `<id>.status` (`success` / `failed`), exactly like the host
 * deployer, so the existing SSE stream + progress UI drive it unchanged.
 */
export function startDevConstructorUpdate(id: string, opts: DevUpdateOpts = {}): void {
  const env = opts.env ?? process.env;
  const dir = devDeployDir(env);
  const spawnFn = opts.spawnImpl ?? spawn;
  const cwd = opts.cwd ?? findWorkspaceRoot();
  mkdirSync(dir, { recursive: true });
  const log = devLogPath(id, env);
  const status = devStatusPath(id, env);
  writeFileSync(log, "");
  writeFileSync(status, "running");

  const started = Date.now();
  const secs = (): number => Math.round((Date.now() - started) / 1000);
  const append = (s: string): void => {
    try {
      appendFileSync(log, s);
    } catch {
      /* non-fatal */
    }
  };

  append(`▶ dev constructor update (localhost — no blue-green on this box)\n`);
  append(`  workspace: ${cwd}\n`);
  append(`  installing: ${DEV_CONSTRUCTORS.join(", ")}\n\n`);

  // Always-moving rule: heartbeat while npm is silent.
  const beat = setInterval(() => append(`  · still working · elapsed ${secs()}s\n`), 6000);
  beat.unref?.();

  const finish = (ok: boolean, note: string): void => {
    clearInterval(beat);
    append(`\n${ok ? "✓" : "✗"} ${note} (${secs()}s)\n`);
    try {
      writeFileSync(status, ok ? "success" : "failed");
    } catch {
      /* non-fatal */
    }
  };

  const run = (args: string[], next: () => void): void => {
    append(`$ npm ${args.join(" ")}\n`);
    let child;
    try {
      child = spawnFn("npm", args, {
        cwd,
        shell: process.platform === "win32", // npm is npm.cmd on Windows
        env: process.env,
      });
    } catch (err) {
      finish(false, `could not start npm: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    child.stdout?.on("data", (d: Buffer) => append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => append(d.toString()));
    child.on("error", (e: Error) => finish(false, `npm failed to start: ${e.message}`));
    child.on("close", (code: number | null) => {
      if (code === 0) next();
      else finish(false, `npm ${args[0]} exited with code ${code}`);
    });
  };

  run(["install", ...DEV_CONSTRUCTORS, "-w", "@ancientpantheon/pythia"], () => {
    append(`\n→ rebuilding so the browser picks up the new constructor UIs\n`);
    run(["run", "build", "-w", "@ancientpantheon/pythia"], () =>
      finish(
        true,
        "constructors updated — the page reloads for the new UIs; restart the dev server to pick up server-side organ changes",
      ),
    );
  });
}
