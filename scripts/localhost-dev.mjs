// Dev launcher that boots the Pythia gateway on the port assigned in the
// central LocalHost registry (D:/_Claude/LocalHost/registry.json). The Pythia
// server reads PORT from the environment (default 8080); we set it from the
// registry. Falls back to 3006 if the registry is absent.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const KEY = "pythia";
const FALLBACK = 3006;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function port() {
  try {
    const reg = JSON.parse(readFileSync(resolve(here, "../../../LocalHost/registry.json"), "utf8"));
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

const child = spawn("node", [dist], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PORT: String(port()) },
});
child.on("exit", (code) => process.exit(code ?? 0));
