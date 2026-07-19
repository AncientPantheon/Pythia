import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Bundle the React Codex-UI island (apps/pythia/codex-ui/) into the served public/
// assets: codex-island.js + codex-island.css. Client-only; mounts into #codex-island
// in the admin. Run by the app build + the Docker image build.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [join(appDir, "codex-ui", "index.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  outfile: join(appDir, "public", "codex-island.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  // @stoachain/* crypto reaches for Node's Buffer; alias node:buffer → the browser
  // polyfill and inject Buffer as a global so those modules resolve in the browser.
  alias: { "node:buffer": "buffer" },
  inject: [join(appDir, "codex-ui", "node-shims.js")],
  loader: { ".css": "css" },
  logLevel: "info",
});

console.log("codex-island bundle written to public/codex-island.{js,css}");
