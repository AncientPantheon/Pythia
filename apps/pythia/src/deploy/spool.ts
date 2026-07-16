import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The **deploy spool** — the container side of the tokenless on-box deploy
 * handshake. The container never touches git or the docker socket: it only
 * drops `<id>.request.json` into the container-writable `requests/` subdir on
 * the shared `pythia-data` volume, and a root systemd path-unit on the host
 * picks the request up and runs the privileged blue-green deployer.
 *
 * The spool is split into two dirs under `PYTHIA_DEPLOY_DIR` so root never
 * writes where the container could plant a symlink:
 *   - `<base>/requests/` — container-writable; `<id>.request.json` dropped here.
 *   - `<base>/state/`     — root-owned on the host; `<id>.log` (append-only) and
 *     `<id>.status` live here. Root writes them; the container only READS them
 *     for the SSE tail. The container must NEVER create a file under `state/`.
 * Protocol mirrors Mnemosyne's `deploy/host/*` (see docs/work/update-deploy).
 *
 * Env is read per call (never cached) so tests and the runtime always see the
 * live `PYTHIA_DEPLOY_DIR` / `NODE_ENV`.
 */

/** The one-word lifecycle a `.status` file moves through. */
export type DeployStatus = "queued" | "running" | "success" | "failed";

/** The body written into `<id>.request.json` for the host deployer. */
export interface DeployRequest {
  id: string;
  mode: string;
  requestedAt: string;
}

/**
 * The spool directory from `PYTHIA_DEPLOY_DIR` (trimmed), or null when unset
 * or blank — null means dev mode: no spool volume, no on-box deploy.
 */
export function deploySpoolDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PYTHIA_DEPLOY_DIR;
  if (raw === undefined) return null;
  const dir = raw.trim();
  return dir === "" ? null : dir;
}

/**
 * `'bundle'` only when the spool dir is configured AND `NODE_ENV=production`
 * — a dev box pointing PYTHIA_DEPLOY_DIR at a scratch dir must stay `'dev'`,
 * and a production container without the volume must not offer Deploy.
 */
export function deployMode(env: NodeJS.ProcessEnv = process.env): "bundle" | "dev" {
  return deploySpoolDir(env) !== null && env.NODE_ENV === "production" ? "bundle" : "dev";
}

/**
 * Path-traversal guard: deploy ids are `crypto.randomUUID()` output, so only
 * hex-and-dashes (8–64 chars) may reach a spool path. Anything else could
 * escape the spool dir (`../evil` → a file outside the volume).
 */
export function isValidDeployId(id: string): boolean {
  return /^[a-f0-9-]{8,64}$/i.test(id);
}

/**
 * The container-writable `<base>/requests/` dir (where `<id>.request.json` is
 * dropped), or null in dev mode (no spool base).
 */
export function requestsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = deploySpoolDir(env);
  return base === null ? null : join(base, "requests");
}

/**
 * The root-owned `<base>/state/` dir (where root writes `<id>.log` /
 * `<id>.status` and the container only reads), or null in dev mode. The
 * container must never create files here.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = deploySpoolDir(env);
  return base === null ? null : join(base, "state");
}

/** The configured requests dir, or throw — path helpers are bundle-mode-only. */
function requireRequestsDir(env: NodeJS.ProcessEnv): string {
  const dir = requestsDir(env);
  if (dir === null) throw new Error("PYTHIA_DEPLOY_DIR is not set (dev mode has no spool)");
  return dir;
}

/** The configured state dir, or throw — path helpers are bundle-mode-only. */
function requireStateDir(env: NodeJS.ProcessEnv): string {
  const dir = stateDir(env);
  if (dir === null) throw new Error("PYTHIA_DEPLOY_DIR is not set (dev mode has no spool)");
  return dir;
}

/** `<base>/requests/<id>.request.json` — the file the host path-unit triggers on. */
export function requestPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(requireRequestsDir(env), `${id}.request.json`);
}

/** `<base>/state/<id>.log` — the root-written append-only build log the SSE stream tails. */
export function logPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(requireStateDir(env), `${id}.log`);
}

/** `<base>/state/<id>.status` — the root-written one-word lifecycle file. */
export function statusPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(requireStateDir(env), `${id}.status`);
}

/**
 * The current one-word status for a deploy, trimmed (the host deployer writes
 * a trailing newline), or null when the file — or the spool dir — is missing.
 */
export function readStatus(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (deploySpoolDir(env) === null) return null;
  try {
    return readFileSync(statusPath(id, env), "utf8").trim();
  } catch {
    return null;
  }
}

/** Whether a status ends the deploy — the SSE loop closes on these. */
export function isTerminalStatus(status: string | null): boolean {
  return status === "success" || status === "failed";
}

/**
 * Seed the container's ONE spool file for a new deploy: `<id>.request.json` in
 * the container-writable `requests/` dir, written via atomic temp+rename so the
 * host path-unit only ever sees the whole JSON. The log and status are NOT
 * created here — they live in the root-owned `state/` dir and root creates them,
 * so the container can never plant a symlink there for root to write through.
 */
export function seedDeployFiles(
  id: string,
  requestBody: DeployRequest,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = requireRequestsDir(env);
  mkdirSync(dir, { recursive: true });
  const target = requestPath(id, env);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(requestBody, null, 2));
  renameSync(tmp, target);
}
