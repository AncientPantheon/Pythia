// Browser `process` shim, injected by esbuild wherever a bundled module references
// the `process` free variable (readable-stream / stream-browserify reach for
// `process.nextTick`). esbuild's `define` handles the literal `process.env.NODE_ENV`;
// this covers every other `process.*` use so the bundle runs in the browser.
const processShim = {
  env: { NODE_ENV: "production" },
  browser: true,
  version: "",
  versions: {},
  platform: "browser",
  argv: [],
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};

export { processShim as process };
