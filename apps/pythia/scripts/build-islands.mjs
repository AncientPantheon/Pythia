import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Bundle the React admin islands into the served public/ assets. Client-only mounts:
//   codex-ui/     → public/codex-island.{js,css}     (#codex-island)
//   khronoton-ui/ → public/khronoton-island.{js,css} (#khronoton-island)
// Run by the app build + the Docker image build. @stoachain/* crypto reaches for
// Node's Buffer, so both bundles alias node:buffer → the browser polyfill and
// inject Buffer as a global.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// Buffer (both islands) + a browser `process` shim (khronoton's stream-browserify
// graph reaches for process.nextTick). Injected wherever those free vars appear.
const shims = [
  join(appDir, "codex-ui", "node-shims.js"),
  join(appDir, "khronoton-ui", "process-shim.js"),
];

// The khronoton-core shared chunk reaches for Node's `crypto` (createHash /
// randomUUID) + `stream` (via crypto-browserify); the codex graph needs neither, so
// these aliases are scoped to the khronoton island to keep the codex bundle lean.
const cryptoShim = join(appDir, "khronoton-ui", "crypto-shim.js");
const islands = [
  { name: "codex-island", entry: join(appDir, "codex-ui", "index.tsx"), extraAlias: {} },
  {
    name: "khronoton-island",
    entry: join(appDir, "khronoton-ui", "index.tsx"),
    extraAlias: {
      crypto: cryptoShim,
      "node:crypto": cryptoShim,
      stream: "stream-browserify",
      "node:stream": "stream-browserify",
    },
  },
];

for (const { name, entry, extraAlias } of islands) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    outfile: join(appDir, "public", `${name}.js`),
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    // @stoachain/* crypto reaches for node:buffer → the browser polyfill (both islands).
    alias: { "node:buffer": "buffer", ...extraAlias },
    inject: shims,
    loader: { ".css": "css" },
    logLevel: "info",
  });
  console.log(`${name} bundle written to public/${name}.{js,css}`);
}
