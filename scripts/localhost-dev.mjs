// Dev launcher that boots the Pythia gateway on the port assigned in the
// central LocalHost registry (D:/_Claude/LocalHost/registry.json). The Pythia
// server reads PORT from the environment (default 8080); we set it from the
// registry. Falls back to 3009 if the registry is absent.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const KEY = "pythia";
const FALLBACK = 3009;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function port() {
  try {
    const reg = JSON.parse(readFileSync(resolve(here, "../../../../LocalHost/registry.json"), "utf8"));
    const p = reg.projects.find((x) => x.key === KEY)?.port;
    return typeof p === "number" ? p : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

const dist = resolve(root, "apps/pythia/dist/server.js");
if (!existsSync(dist)) {
  console.error("Pythia dist not built. Run:  npm run build   (in the Pythia root) then retry.");
  process.exit(1);
}

// Load optional LOCAL dev env (OIDC login wiring etc.) from a gitignored file so
// the aggregator/`npm run dev` start path wires login without pasting secrets.
// Absent → boots as the plain public gateway (no admin SSO), unchanged.
function loadLocalEnv() {
  const file = resolve(root, "apps/pythia/pythia.local.env");
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    if (out.PYTHIA_OIDC_CLIENT_ID) {
      console.log("pythia dev: loaded apps/pythia/pythia.local.env (OIDC login wired)");
    }
  } catch {
    /* no local env file — run as the public gateway */
  }
  return out;
}

const child = spawn("node", [dist], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  // Registry PORT wins over anything in the local env file.
  env: { ...process.env, ...loadLocalEnv(), PORT: String(port()) },
});
child.on("exit", (code) => process.exit(code ?? 0));
